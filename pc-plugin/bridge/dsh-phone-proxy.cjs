// Phone -> desktop app bridge.
//
// tailscale serve forwards the phone here. Host/Origin are rewritten to a fixed
// loopback authority (127.0.0.1:4505) so the app's browser-trust fence accepts
// the requests and login cookies stay valid across app restarts and port
// changes. The app's real web port is taken from argv and re-discovered on
// connection failures.
//
// Login is fully automatic: when a request arrives without a dsh-auth cookie
// (typical for Android home-screen / external-app launches, which browsers
// treat as cross-site and therefore drop SameSite=Strict cookies), the proxy
// performs the token exchange with the local `dsh web` instance on the phone's
// behalf and answers a redirect carrying the cookie as SameSite=Lax.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { execFile } = require('child_process');

// A proxy must never die: log and keep serving.
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));

const LISTEN_PORT = Number(process.env.DSH_PHONE_PORT) || 8124;
const CLI_PORT = Number(process.env.DSH_PHONE_CLI_PORT) || 8090; // local `dsh web` instance - performs token exchange
const AUTHORITY = '127.0.0.1:4505'; // stable identity the app trusts (loopback)
const DISCOVER = path.join(__dirname, 'find-app-port.ps1');
const CLI_LOG = process.env.DSH_PHONE_CLI_LOG || require('path').join(require('os').homedir(), '.dsh', 'logs', 'dsh-web-serve.log');
const COOKIE_ATTRS = '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax';
let appPort = Number(process.argv[2]) || 4505;

let discoveryPromise = null;
function discoverAppPort() {
  // All failing requests share one scan instead of spawning a PowerShell scan each.
  if (!discoveryPromise) {
    discoveryPromise = scanAppPort().finally(() => { discoveryPromise = null; });
  }
  return discoveryPromise;
}

async function scanAppPort() {
  const run = () => new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DISCOVER], { timeout: 10000 }, async (err, out) => {
      const cands = String(out || '').split(/\s+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
      if (!cands.length) return resolve(null);
      // The app process can host several web roots, each with its own signing
      // secret. Pick the root the minter's cookie actually unlocks: mint one
      // and probe GET / — the wrong root answers 401 even with a valid cookie.
      //
      // But a 200 alone is NOT enough: the same Electron process also hosts
      // other plugin web surfaces on their own ports (e.g. the SnowLuma console
      // on :5100) which answer 200 for any request and are scanned first because
      // they use lower port numbers. Sending the phone there opens the wrong UI.
      // So require the body to look like the DSH workbench (window.__DSH_BOOT__),
      // which every real DSH web root injects and no other surface has.
      let pair = null;
      try { pair = await mintCookie(); } catch {}
      if (!pair) return resolve(null); // minter not ready yet — caller retries

      // Several roots can pass the `__DSH_BOOT__` test, so rank them by how
      // complete the composed profile is. The plugin starts its own `dsh web`
      // cookie-minter, which is a bare base+web-app profile: it serves the
      // workbench shell but none of the user's plugins, models, or sessions.
      // Picking it made the phone show an empty app — no plugins, only the
      // built-in DeepSeek model, every session "stopped", and a 404 on
      // /phone-remote/state. So probe each candidate and prefer the root that
      // advertises the most plugin bundles.
      const scored = [];
      for (const port of cands) {
        const probe = await new Promise((res) => {
          let body = '';
          const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', headers: { host: AUTHORITY, origin: 'http://' + AUTHORITY, cookie: pair } }, (up) => {
            if (up.statusCode !== 200) { up.resume(); return res({ ok: false }); }
            up.setEncoding('utf8');
            up.on('data', (d) => { if (body.length < 262144) body += d; });
            up.on('end', () => {
              if (!body.includes('__DSH_BOOT__')) return res({ ok: false });
              // Plugin count is the cheapest proxy for "this is the composed
              // profile the user actually runs".
              const combos = new Set((body.match(/plugins\/\?\?[^"'\s]+/g) || []));
              let modules = 0;
              for (const c of combos) modules += c.split(',').length;
              res({ ok: true, modules });
            });
            up.on('error', () => res({ ok: false }));
          });
          req.on('error', () => res({ ok: false }));
          req.setTimeout(6000, () => { req.destroy(); res({ ok: false }); });
          req.end();
        });
        if (probe.ok) scored.push({ port, modules: probe.modules });
      }
      if (!scored.length) return resolve(null);
      scored.sort((a, b) => b.modules - a.modules);
      if (scored.length > 1) {
        console.log('dsh phone proxy: web 根候选 ' + scored.map((s) => ':' + s.port + '(' + s.modules + ')').join(' ')
          + ' → 选 :' + scored[0].port);
      }
      resolve(scored[0].port);
    });
  });
  // Retry for a while: at startup the minter may not have printed its token yet,
  // and picking a wrong/guessed port sticks until the next failure.
  for (let i = 0; i < 15; i++) {
    const p = await run();
    if (p) { appPort = p; return appPort; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return appPort; // keep previous value; forward() will retry on 401
}

function readCliToken() {
  try {
    const raw = fs.readFileSync(CLI_LOG, 'utf8').split(String.fromCharCode(0)).join('');
    const all = [...raw.matchAll(/token=([A-Za-z0-9_\-]+)/g)];
    return all.length ? all[all.length - 1][1] : null; // latest minter token wins
  } catch {
    return null;
  }
}

// Perform the launch-token exchange server-side; returns "cookieName=cookieValue".
function mintCookie() {
  return new Promise((resolve, reject) => {
    const token = readCliToken();
    if (!token) return reject(new Error('login token not found'));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: CLI_PORT,
        method: 'GET',
        path: '/?token=' + encodeURIComponent(token),
        headers: { host: AUTHORITY, origin: 'http://' + AUTHORITY },
      },
      (up) => {
        const sc = up.headers['set-cookie'];
        up.resume();
        const pair = Array.isArray(sc) && sc.length ? sc[0].split(';')[0].trim() : null;
        if (up.statusCode >= 300 && up.statusCode < 400 && pair) return resolve(pair);
        reject(new Error('token exchange failed: ' + up.statusCode));
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('token exchange timeout')));
    req.end();
  });
}

async function autoLogin(res) {
  try {
    const pair = await mintCookie();
    res.writeHead(303, {
      'set-cookie': pair + COOKIE_ATTRS,
      location: './',
      'cache-control': 'no-store',
      // COOP/COEP must be on EVERY hop of the redirect chain or the final
      // document is not cross-origin isolated (no SharedArrayBuffer).
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
    });
    res.end();
  } catch (e) {
    waitingPage(res, '登录服务未就绪，请稍后刷新（' + e.message + '）');
  }
}

function rewriteHeaders(headers) {
  // Keep accept-encoding intact: compressed responses are the difference
  // between a 5-second and a 50-second load over a relay link.
  return { ...headers, host: AUTHORITY, origin: 'http://' + AUTHORITY };
}

function rewriteSetCookie(headers) {
  if (headers['set-cookie']) {
    headers['set-cookie'] = headers['set-cookie'].map((c) => c.split(';')[0].trim() + COOKIE_ATTRS);
  }
  return headers;
}

function waitingPage(res, note) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5"><title>等待桌面 App</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;text-align:center;padding:0 24px}</style>
</head><body><div><h2>正在等待电脑上的 DSH 桌面 App…</h2>
<p>${note || 'App 未启动或还在启动中，本页每 5 秒自动重试。'}</p>
<p>若长时间没有反应，回到电脑上 DSH 的「设置 → 手机远程」，看「登录签发端口」是否显示运行中；那里会直接给出失败原因，点「重启桥接」可重拉。</p></div></body></html>`);
}

// Plain-text health probe. The DSHgo app never needs this, but it lets you tell
// "bridge is down" apart from "bridge is up but the app root is wrong" from a
// phone browser, without a valid cookie.
function healthPage(res) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify({
    ok: true,
    bridge: LISTEN_PORT,
    appPort,
    cliPort: CLI_PORT,
    tailIp: findTailIp(),
    lanIps: typeof findLanIps === 'function' ? findLanIps() : [],
    cache: typeof cacheStats === 'function' ? cacheStats() : null,
    ws: typeof wsStats === 'function' ? wsStats() : null,
    at: new Date().toISOString(),
  });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function forward(req, res, targetPort, retried, pathOverride) {
  if (res.destroyed || res.writableEnded) return;
  // pathOverride lets /__insp fall back onto the app root with the prefix
  // already stripped (see forwardInspector).
  const targetPath = pathOverride || req.url;
  // A consumed request body cannot be replayed. Never retry commands/uploads.
  const canRetry = !retried && (req.method === 'GET' || req.method === 'HEAD')
    && !req.headers['transfer-encoding'] && !Number(req.headers['content-length']);
  const upstream = http.request(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: targetPath, headers: rewriteHeaders(req.headers) },
    (up) => {
      upstream.setTimeout(0);
      up.on('error', () => res.destroy());
      up.on('aborted', () => res.destroy());
      const headers0 = { ...up.headers };
      const type0 = String(headers0['content-type'] || '');
      // A 401 JSON from the wrong web root (another listener of the app) looks
      // identical to a real auth failure to the phone. Re-discover the right
      // root once before surfacing it.
      if (canRetry && up.statusCode === 401 && /json/.test(type0)) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', async () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (/Authorization bearer|invalid_api_key|"unauthorized"/i.test(body)) {
            const p = await discoverAppPort();
            if (p && p !== targetPort && !res.destroyed) return forward(req, res, p, true, pathOverride);
          }
          const h = { ...headers0, 'cross-origin-resource-policy': 'cross-origin' };
          if (res.destroyed) return;
          res.writeHead(up.statusCode, h);
          res.end(Buffer.concat(chunks));
        });
        return;
      }
      const headers = rewriteSetCookie({ ...up.headers });
      const type = String(headers['content-type'] || '');
      const wantsGzip = /gzip/.test(String(req.headers['accept-encoding'] || ''));
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      // Enable SharedArrayBuffer (the file-resource/WASM service needs it):
      // cross-origin isolation headers on HTML documents. credentialless keeps
      // SAB working while letting plain cross-origin images (e.g. the account
      // avatar from an external CDN, no CORP header) render — require-corp
      // silently blocked those.
      if (/text\/html/.test(type)) {
        headers['cross-origin-opener-policy'] = 'same-origin';
        headers['cross-origin-embedder-policy'] = 'credentialless';
      }
      headers['cross-origin-resource-policy'] = 'cross-origin';
      // Large uncompressed text/JSON (e.g. image payloads) is slow over the
      // relay until the client aborts. Compress it here - raw bytes only, no
      // content modification, so nothing can be corrupted.
      const bigType = /json|text|javascript|xml/.test(type);
      const streaming = /event-stream|ndjson|json-seq/i.test(type);
      if (!enc && wantsGzip && bigType && !streaming && req.method !== 'HEAD'
          && up.statusCode !== 204 && up.statusCode !== 304
          && !headers['content-range'] && !/no-transform/i.test(headers['cache-control'] || '')) {
        delete headers['content-length'];
        headers['content-encoding'] = 'gzip';
        headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
        res.writeHead(up.statusCode, headers);
        // Bounded memory, backpressure, and prompt delivery even for a long-lived body.
        pipeline(up, zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }), res, () => {});
        return;
      }
      res.writeHead(up.statusCode, headers);
      if (streaming) res.flushHeaders();
      up.pipe(res);
      void enc;
    }
  );
  upstream.on('error', async (e) => {
    if (res.destroyed || res.writableEnded) return;
    if (canRetry && !res.headersSent && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) {
      return forward(req, res, await discoverAppPort(), true);
    }
    waitingPage(res);
  });
  upstream.setTimeout(30000, () => upstream.destroy(new Error('upstream response timeout')));
  res.once('close', () => upstream.destroy());
  req.once('aborted', () => upstream.destroy());
  if (retried) upstream.end();
  else req.pipe(upstream);
}

// The rewritten /__insp path routes to the app's local resource/inspector port.
// That port (9230) only exists when the desktop app opened its own inspector;
// on a plain install nothing listens there. Rather than answer every request
// with a 503 waiting page (which the phone WebView reports as a hard load
// failure), fall back to the real app root with the prefix stripped.
function forwardInspector(req, res) {
  const rel = req.url.replace(/^\/__insp/, '') || '/';
  const target = {
    host: '127.0.0.1',
    port: 9230,
    method: req.method,
    path: rel,
    headers: { ...req.headers, host: '127.0.0.1:9230' },
  };
  const headOnly = req.method === 'GET' || req.method === 'HEAD';
  const up = http.request(target, (u) => {
    res.writeHead(u.statusCode, rewriteSetCookie({ ...u.headers }));
    u.pipe(res);
  });
  up.on('error', () => {
    if (res.destroyed || res.headersSent) return;
    // Retry once against the app root; forward() replays only GET/HEAD.
    forward(req, res, appPort, !headOnly, rel);
  });
  if (!headOnly) req.pipe(up);
  else up.end();
}

// ---- multi-site aggregation: stream local PC pages to the phone ----
// /__site/<relative-path> serves files from SITE_ROOT (default: the user's
// Desktop). General-purpose: any local html/file can be added as a "site".
const SITE_ROOT = process.env.DSH_SITE_ROOT || require('path').join(process.env.USERPROFILE || require('os').homedir(), 'Desktop');
const SITE_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webp': 'image/webp'
};
function serveSite(req, res) {
  try {
    let raw = req.url.replace(/^\/__site\//, '').split('?')[0];
    if (raw.indexOf('%') >= 0) {
      try { raw = decodeURIComponent(raw); } catch (e) {}
    } else {
      raw = Buffer.from(raw, 'latin1').toString('utf8'); // raw-byte URLs (non-ASCII names)
    }
    const pathMod = require('path');
    const full = pathMod.normalize(pathMod.join(SITE_ROOT, raw));
    const rootNorm = pathMod.normalize(SITE_ROOT);
    if (!full.toLowerCase().startsWith(rootNorm.toLowerCase())) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.stat(full, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404); return res.end('site file not found'); }
      const ext = pathMod.extname(full).toLowerCase();
      const type = SITE_TYPES[ext] || 'application/octet-stream';
      if (/\.html?$/i.test(full)) {
        // Universal local-port passthrough: pages streamed to the phone keep
        // calling http://127.0.0.1:<port> (their local APIs). Rewrite those to
        // /__local/<port>/… so the request travels back through the tunnel to
        // the PC's loopback — works for ANY monitoring page, no per-page edits.
        return fs.readFile(full, (e2, buf) => {
          if (e2 || !buf) { res.writeHead(500); return res.end('site read error'); }
          let html = buf.toString('utf8');
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (h) => h + SITE_SHIM);
          } else {
            html = SITE_SHIM + html;
          }
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
          res.end(html);
        });
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('site error');
  }
}

// Injected into every streamed HTML page: rewrites 127.0.0.1/localhost URLs to
// /__local/<port>/… so fetch / XHR / WebSocket / DOM resources all reach the
// PC's loopback through the tunnel instead of the phone's own loopback.
const SITE_SHIM = `<script>(function(){
function rw(u){
  try{
    if (typeof u !== 'string') return u;
    if (u.charAt(0) === '/' && u.substring(0,2) !== '//') return u;
    var url = new URL(u, location.href);
    var h = url.hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1') {
      var port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
      return '/__local/' + port + url.pathname + url.search + url.hash;
    }
  }catch(e){}
  return u;
}
var of = window.fetch;
if (of) window.fetch = function(i, n){
  try{
    if (typeof i === 'string') i = rw(i);
    else if (i && i.url) i = new Request(rw(i.url), i);
  }catch(e){}
  return of.call(this, i, n);
};
var oo = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m, u){
  try{ arguments[1] = rw(u); }catch(e){}
  return oo.apply(this, arguments);
};
var OWS = window.WebSocket;
if (OWS) {
  window.WebSocket = function(u, p){
    var r = rw(u);
    if (r !== u) r = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + r;
    return p !== undefined ? new OWS(r, p) : new OWS(r);
  };
  window.WebSocket.prototype = OWS.prototype;
  window.WebSocket.CONNECTING = OWS.CONNECTING;
  window.WebSocket.OPEN = OWS.OPEN;
  window.WebSocket.CLOSING = OWS.CLOSING;
  window.WebSocket.CLOSED = OWS.CLOSED;
}
var OES = window.EventSource;
if (OES) window.EventSource = function(u, c){ return new OES(rw(u), c); };
function fixEl(el){
  try{
    if (!el || !el.getAttribute || el.__lfix) return;
    var as = ['src','href','action','poster','data-src'], i, a, v, r;
    for (i = 0; i < as.length; i++) {
      a = as[i]; v = el.getAttribute(a);
      if (!v) continue;
      r = rw(v);
      if (r !== v) { el.setAttribute(a, r); el.__lfix = 1; }
    }
  }catch(e){}
}
function fixAll(root){
  try{
    fixEl(root);
    var els = root.querySelectorAll ? root.querySelectorAll('[src],[href],[action],[poster]') : [];
    for (var i = 0; i < els.length; i++) fixEl(els[i]);
  }catch(e){}
}
document.addEventListener('DOMContentLoaded', function(){
  fixAll(document);
  try{
    new MutationObserver(function(ms){
      for (var i = 0; i < ms.length; i++) {
        var ad = ms[i].addedNodes;
        for (var j = 0; j < ad.length; j++) fixAll(ad[j]);
      }
    }).observe(document, { childList: true, subtree: true });
  }catch(e){}
});
})();</script>`;

// /__local/<port>/<path> -> http://127.0.0.1:<port>/<path> (loopback only)
function forwardLocal(req, res) {
  const m = req.url.match(/^\/__local\/(\d+)(\/.*)?$/);
  if (!m) { res.writeHead(400); return res.end('bad local path'); }
  const port = parseInt(m[1], 10);
  const path = m[2] || '/';
  const headers = { ...req.headers };
  delete headers.cookie; // never leak app cookies to random local services
  headers.host = '127.0.0.1:' + port;
  headers.origin = 'http://127.0.0.1:' + port;
  if (headers.referer) headers.referer = 'http://127.0.0.1:' + port + '/';
  const r = http.request({ host: '127.0.0.1', port, method: req.method, path, headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  r.on('error', () => { res.writeHead(502); res.end('local service unreachable'); });
  req.pipe(r);
}

// ---- WebSocket compression for the Remote stream mux ----
//
// `/api/remote.mux` is the single WebSocket carrying every Typert Remote
// stream: session transcripts, projections, live turns. The Host builds its
// server as `new WebSocketServer({ noServer: true })`, and the `ws` package
// defaults `perMessageDeflate` to **false** — so those frames ship
// uncompressed. One session projection is ~1.6 MB of highly repetitive JSON
// that gzips to ~0.35 MB; over a DERP relay (≈275 ms RTT) the phone waits for
// every raw byte, which is exactly the "opening a session takes forever" case.
//
// A plugin cannot reconfigure the Host's WebSocketServer, so the negotiation is
// moved here: the bridge terminates the WebSocket on both legs with its own
// `ws` instances — compressed towards the phone, plain towards the Host — and
// pumps messages between them. `/__insp` and `/__local/` stay on the byte
// passthrough: they carry arbitrary framing for local services.
//
// Set DSH_PHONE_WS_COMPRESS=0 to disable (falls back to the plain proxy).
const WS_COMPRESS = String(process.env.DSH_PHONE_WS_COMPRESS || '1') !== '0';

let WsModule = null;
let WsTried = false;
function loadWs() {
  if (WsTried) return WsModule;
  WsTried = true;
  // Under the desktop app the bridge runs as Electron-in-node-mode, so `ws`
  // lives inside app.asar; under plain Node it is only there if installed.
  const candidates = [];
  try {
    const exeDir = path.dirname(process.execPath);
    candidates.push(path.join(exeDir, 'resources', 'app.asar', 'node_modules', 'ws'));
  } catch (e) {}
  candidates.push('ws');
  for (const c of candidates) {
    try {
      const m = require(c);
      if (m && typeof m.WebSocketServer === 'function' && typeof m.WebSocket === 'function') {
        WsModule = m;
        break;
      }
    } catch (e) {}
  }
  if (!WsModule) console.error('dsh phone proxy: ws 不可用，WebSocket 不压缩');
  return WsModule;
}

function wsStats() {
  return { enabled: WS_COMPRESS, available: !!loadWs(), compressed: wsCompressed, fallbacks: wsFallback };
}
let wsCompressed = 0;
let wsFallback = 0;

/**
 * Terminate the phone's WebSocket with compression, reconnect to the Host
 * plainly, and pump messages across. Any failure falls back to the raw
 * passthrough so an optimisation never costs a working connection.
 */
function proxyUpgradeCompressed(req, socket, head, port, pathOverride, hostHeader) {
  const WS = loadWs();
  if (!WS || socket.destroyed) {
    wsFallback++;
    return proxyUpgrade(req, socket, head, port, pathOverride, hostHeader);
  }

  const targetPath = pathOverride || req.url;
  const headers = rewriteHeaders(req.headers);
  // The Host must answer a *plain* upgrade: offering an extension we are not
  // going to forward would leave it encoding frames we then misread.
  // Keep cookie: the Host admits the upgrade by session cookie. Only the
  // WebSocket handshake headers are dropped — ws regenerates them.
  for (const k of ['sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-version', 'connection', 'upgrade']) {
    delete headers[k];
  }
  if (hostHeader) headers['host'] = hostHeader;

  let client = null;
  let upstream = null;
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    try { if (upstream) upstream.terminate(); } catch (e) {}
    try { if (client) client.terminate(); } catch (e) {}
    try { socket.destroy(); } catch (e) {}
  };

  const wss = new WS.WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 512,
      zlibDeflateOptions: { level: 6, memLevel: 8 },
      zlibInflateOptions: { chunkSize: 16 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
    },
    maxPayload: 128 * 1024 * 1024,
  });
  wss.on('error', () => {});

  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      ws.on('error', shutdown);
      ws.on('close', shutdown);

      const url = `ws://127.0.0.1:${port}${targetPath}`;
      upstream = new WS.WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
      // Keep the bridge out of protocol-level ping handling: `ws` answers pings
      // on each leg automatically, which is what the Host's heartbeat expects.
      upstream.binaryType = 'nodebuffer';
      ws.binaryType = 'nodebuffer';

      upstream.on('open', () => {
        wsCompressed++;
      });
      upstream.on('message', (data, isBinary) => {
        if (ws.readyState !== WS.WebSocket.OPEN) return;
        try { ws.send(data, { binary: isBinary }); } catch (e) { shutdown(); }
      });
      ws.on('message', (data, isBinary) => {
        if (!upstream || upstream.readyState !== WS.WebSocket.OPEN) return;
        try { upstream.send(data, { binary: isBinary }); } catch (e) { shutdown(); }
      });
      upstream.on('close', () => { try { ws.close(); } catch (e) {} shutdown(); });
      upstream.on('error', () => {
        // Host unreachable mid-handshake: hand the phone a clean close rather
        // than a silent hang, which its reconnect logic understands.
        try { ws.close(1011, 'upstream unavailable'); } catch (e) {}
        shutdown();
      });
    });
  } catch (e) {
    console.error('ws 压缩握手失败，回退直通：' + (e && e.message));
    wsFallback++;
    shutdown();
    return;
  }

  // If the phone vanishes before the handshake finishes, tear the peer down too.
  socket.once('error', shutdown);
  socket.once('close', shutdown);
}

/**
 * Pick the upgrade strategy for one request path.
 * Only the app's own Remote mux is reframed; everything else stays verbatim.
 */
function upgradeFor(req, socket, head, port, pathOverride, hostHeader) {
  const p = pathOverride || req.url;
  if (WS_COMPRESS && p.startsWith('/api/')) {
    return proxyUpgradeCompressed(req, socket, head, port, p, hostHeader);
  }
  return proxyUpgrade(req, socket, head, port, pathOverride, hostHeader);
}

function proxyUpgrade(req, socket, head, port, pathOverride, hostHeader) {
  const headers = rewriteHeaders(req.headers);
  headers['connection'] = 'Upgrade';
  headers['upgrade'] = req.headers.upgrade || 'websocket';
  if (hostHeader) headers['host'] = hostHeader;
  const r = http.request({ host: '127.0.0.1', port, method: req.method, path: pathOverride || req.url, headers });
  let peer = null;
  const close = () => {
    r.destroy();
    if (peer) peer.destroy();
    socket.destroy();
  };
  socket.once('error', close);
  socket.once('close', close);
  r.setTimeout(15000, close);
  r.on('upgrade', (res, upstream, headBuf) => {
    peer = upstream;
    r.setTimeout(0);
    upstream.setTimeout(0);
    upstream.once('error', close);
    upstream.once('close', close);
    if (socket.destroyed) { close(); return; }
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(res.headers)) {
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (headBuf && headBuf.length) socket.write(headBuf);
    if (head && head.length) upstream.write(head);
    // keepalive: relays love to drop idle tunnels
    try { socket.setKeepAlive(true, 15000); upstream.setKeepAlive(true, 15000); socket.setNoDelay(true); upstream.setNoDelay(true); } catch (e) {}
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  r.on('response', (res) => {
    r.setTimeout(0);
    res.once('error', close);
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`];
    for (const [k, v] of Object.entries(res.headers)) {
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    res.pipe(socket);
  });
  r.on('error', close);
  r.end();
}

// ---- fast path: pre-compressed body cache + inlined-artwork offload ----
//
// The app ships its client plugins as one combo request per plugin group
// (`/plugins/??a/client.js,b/client.js,...&rev=<hash>`). Several of those combos
// embed desktop onboarding artwork as multi-megabyte base64 data URIs, and the
// combo bodies are otherwise shipped unminified. Over a relay link (or any slow
// uplink) the phone pays for every one of those bytes on every cold load, even
// though the artwork only ever renders during first-run onboarding.
//
// So: buffer each combo once, lift every big data URI out into its own
// content-addressed file, and store three variants of the rewritten body
// (identity / gzip / brotli) on disk. Repeat loads become a plain file read
// with the best encoding the client accepts, and the artwork is only fetched
// when a component actually renders it.
//
// The URL carries `rev=<hash>`, so a key derived from the URL is invalidated
// automatically whenever the app updates. Set DSH_PHONE_FAST=0 to disable.
const crypto = require('crypto');
const osMod = require('os');

const FAST_PATH = String(process.env.DSH_PHONE_FAST || '1') !== '0';
const CACHE_ROOT = process.env.DSH_PHONE_CACHE || path.join(osMod.homedir(), '.dsh', 'phone-remote-cache');
const BODY_DIR = path.join(CACHE_ROOT, 'bodies');
const ASSET_DIR = path.join(CACHE_ROOT, 'assets');
// Below this a body is not worth a round trip through disk.
const COMBO_MIN = 32 * 1024;
const DATA_URI_RE = /data:image\/(webp|png|jpeg|jpg|gif|svg\+xml);base64,([A-Za-z0-9+/=]{8192,})/g;
const ASSET_TYPE = {
  webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  gif: 'image/gif', 'svg+xml': 'image/svg+xml', svg: 'image/svg+xml',
};

if (FAST_PATH) {
  for (const d of [BODY_DIR, ASSET_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
}

function sha1hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// Bounded parallelism: the phone opens every combo at once and Node is single
// threaded, so builds queue instead of starving the loop.
const JOB_MAX = 4;
let jobActive = 0;
const jobQueue = [];
function acquireSlot() {
  return new Promise((resolve) => {
    if (jobActive < JOB_MAX) { jobActive++; return resolve(); }
    jobQueue.push(resolve);
  });
}
function releaseSlot() {
  const next = jobQueue.shift();
  if (next) return next();
  if (jobActive > 0) jobActive--;
}

function gzipAsync(buf) {
  return new Promise((res, rej) => zlib.gzip(buf, { level: 9 }, (e, out) => (e ? rej(e) : res(out))));
}
function brotliAsync(buf) {
  return new Promise((res, rej) => zlib.brotliCompress(
    buf,
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } },
    (e, out) => (e ? rej(e) : res(out))
  ));
}

// Replace every big inline image with a stable URL, and hand back the bytes so
// the caller can persist them. Small icons stay inline: a separate request
// costs more than the bytes it saves.
function collectAssets(text) {
  const assets = [];
  const out = text.replace(DATA_URI_RE, (whole, type, data) => {
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch (e) { return whole; }
    if (!buf.length) return whole;
    const ext = type === 'svg+xml' ? 'svg' : type;
    const name = sha1hex(buf) + '.' + ext;
    assets.push({ name, buf });
    return '/__asset/' + name;
  });
  return { text: out, assets };
}

function fetchIdentity(targetPort, urlPath) {
  return new Promise((resolve, reject) => {
    const up = http.request(
      {
        host: '127.0.0.1', port: targetPort, method: 'GET', path: urlPath,
        headers: { host: AUTHORITY, origin: 'http://' + AUTHORITY, 'accept-encoding': 'identity' },
      },
      (r) => {
        if (r.statusCode !== 200) { r.resume(); return reject(new Error('upstream ' + r.statusCode)); }
        const chunks = [];
        let size = 0;
        r.on('data', (c) => {
          size += c.length;
          if (size > 64 * 1024 * 1024) { r.destroy(); return reject(new Error('body too large')); }
          chunks.push(c);
        });
        r.on('error', reject);
        r.on('end', () => {
          let body = Buffer.concat(chunks);
          const enc = String(r.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') body = zlib.gunzipSync(body);
            else if (enc === 'br') body = zlib.brotliDecompressSync(body);
            else if (enc === 'deflate') body = zlib.inflateSync(body);
          } catch (e) {}
          resolve({ body, headers: r.headers });
        });
      }
    );
    up.on('error', reject);
    up.setTimeout(60000, () => up.destroy(new Error('combo upstream timeout')));
    up.end();
  });
}

async function buildEntry(urlPath, targetPort, key) {
  const { body, headers } = await fetchIdentity(targetPort, urlPath);
  const type = String(headers['content-type'] || 'text/javascript; charset=utf-8');
  const { text, assets } = collectAssets(body.toString('utf8'));
  for (const a of assets) {
    const p = path.join(ASSET_DIR, a.name);
    if (!fs.existsSync(p)) { try { fs.writeFileSync(p, a.buf); } catch (e) {} }
  }
  const raw = Buffer.from(text, 'utf8');
  const wantBrotli = raw.length <= 24 * 1024 * 1024;
  const [gz, br] = await Promise.all([
    gzipAsync(raw),
    wantBrotli ? brotliAsync(raw).catch(() => null) : Promise.resolve(null),
  ]);
  const meta = {
    url: urlPath,
    type,
    raw: key + '.raw',
    gz: gz ? key + '.gz' : '',
    br: br ? key + '.br' : '',
    rawLen: raw.length,
    gzLen: gz ? gz.length : 0,
    brLen: br ? br.length : 0,
    assets: assets.length,
    at: Date.now(),
  };
  await Promise.all([
    fs.promises.writeFile(path.join(BODY_DIR, meta.raw), raw),
    gz ? fs.promises.writeFile(path.join(BODY_DIR, meta.gz), gz) : null,
    br ? fs.promises.writeFile(path.join(BODY_DIR, meta.br), br) : null,
  ].filter(Boolean));
  await fs.promises.writeFile(path.join(BODY_DIR, key + '.json'), JSON.stringify(meta));
  console.log('fast path: ' + urlPath.slice(0, 56) + '… raw ' + meta.rawLen + ' gz ' + meta.gzLen
    + ' br ' + meta.brLen + ' assets ' + meta.assets);
  return meta;
}

function pickVariant(req, meta) {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (meta.br && /\bbr\b/.test(ae)) return { file: meta.br, enc: 'br', len: meta.brLen };
  if (meta.gz && /\bgzip\b/.test(ae)) return { file: meta.gz, enc: 'gzip', len: meta.gzLen };
  return { file: meta.raw, enc: '', len: meta.rawLen };
}

function sendCached(req, res, meta) {
  const v = pickVariant(req, meta);
  const file = path.join(BODY_DIR, v.file);
  let st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const headers = {
    'content-type': meta.type,
    'content-length': st.size,
    'cache-control': 'public, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'cross-origin',
    vary: 'Accept-Encoding',
  };
  if (v.enc) headers['content-encoding'] = v.enc;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

// Serve a combo from the transform cache, building it on first sight.
async function serveCombo(req, res, targetPort) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return forward(req, res, targetPort, false);
  const key = sha1hex(Buffer.from(req.url));
  const metaPath = path.join(BODY_DIR, key + '.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
    if (meta && sendCached(req, res, meta)) return;
    if (meta) { try { fs.unlinkSync(metaPath); } catch (e) {} }
    if (attempt > 0) break;
    await acquireSlot();
    try {
      // Another request may have finished the build while we queued.
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
      if (!meta) meta = await buildEntry(req.url, targetPort, key);
    } catch (e) {
      console.error('fast path fallback (' + (e && e.message) + '): ' + req.url.slice(0, 80));
      releaseSlot();
      return forward(req, res, targetPort, false);
    }
    releaseSlot();
  }
  forward(req, res, targetPort, false);
}

function serveAsset(req, res) {
  const name = String(req.url).slice('/__asset/'.length).split('?')[0];
  if (!/^[0-9a-f]{40}\.[a-z0-9]{2,5}$/.test(name)) { res.writeHead(400); return res.end('bad asset name'); }
  const file = path.join(ASSET_DIR, name);
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('asset missing'); }
    const ext = name.split('.').pop();
    res.writeHead(200, {
      'content-type': ASSET_TYPE[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'public, max-age=31536000, immutable',
      'cross-origin-resource-policy': 'cross-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// Drop cache entries nobody asked for in a month (app updates rotate the rev,
// so stale revisions pile up until pruned).
function pruneCache() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let removed = 0;
  for (const dir of [BODY_DIR, ASSET_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch (e) {}
    }
  }
  if (removed) console.log('fast path: pruned ' + removed + ' stale cache files');
}

function cacheStats() {
  let bodies = 0;
  let assets = 0;
  try { bodies = fs.readdirSync(BODY_DIR).filter((n) => n.endsWith('.json')).length; } catch (e) {}
  try { assets = fs.readdirSync(ASSET_DIR).length; } catch (e) {}
  return { enabled: FAST_PATH, bodies, assets };
}

// Build the whole combo set ahead of time.
//
// The phone cannot start rendering until every combo in the first-paint HTML
// has arrived, and a cold combo costs a full fetch-transform-compress cycle
// before the first byte leaves the PC. Doing that work while nobody is waiting
// turns the phone's first load into a plain file read. Runs once per app-port
// change, in the background, so it never delays a live request.
let prewarmKey = '';
let prewarmRunning = false;

async function prewarm() {
  if (!FAST_PATH || prewarmRunning) return;
  const key = appPort + '@' + LISTEN_PORT;
  if (prewarmKey === key) return;
  prewarmRunning = true;
  const started = Date.now();
  try {
    let cookie = '';
    try { cookie = await mintCookie(); } catch (e) { return; }
    const html = await new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1', port: appPort, method: 'GET', path: '/',
          headers: { host: AUTHORITY, origin: 'http://' + AUTHORITY, cookie },
        },
        (u) => {
          const chunks = [];
          u.on('data', (c) => chunks.push(c));
          u.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          u.on('error', reject);
        }
      );
      r.on('error', reject);
      r.setTimeout(20000, () => r.destroy(new Error('prewarm html timeout')));
      r.end();
    });
    // The HTML attribute encodes the separator as &amp;; the combo route only
    // matches the raw form, so unescape before requesting.
    const urls = [...new Set([...html.matchAll(/\/?(plugins\/\?\?[^"'\s]+)/g)]
      .map((m) => '/' + m[1].split('&amp;').join('&')))];
    let built = 0;
    let hit = 0;
    for (const u of urls) {
      const key2 = sha1hex(Buffer.from(u));
      if (fs.existsSync(path.join(BODY_DIR, key2 + '.json'))) { hit++; continue; }
      await acquireSlot();
      try {
        if (!fs.existsSync(path.join(BODY_DIR, key2 + '.json'))) await buildEntry(u, appPort, key2);
        built++;
      } catch (e) {
        console.error('prewarm skip (' + (e && e.message) + '): ' + u.slice(0, 60));
      } finally {
        releaseSlot();
      }
    }
    prewarmKey = key;
    console.log('fast path: prewarm done, ' + built + ' built, ' + hit + ' cached, '
      + ((Date.now() - started) / 1000).toFixed(1) + 's');
  } catch (e) {
    console.error('prewarm failed: ' + (e && e.message));
  } finally {
    prewarmRunning = false;
  }
}

http
  .createServer((req, res) => {
    if (req.url === '/__health') return healthPage(res);
    if (FAST_PATH && req.url.startsWith('/__asset/')) return serveAsset(req, res);
    if (req.url.startsWith('/__insp')) return forwardInspector(req, res);
    if (req.url.startsWith('/__site/')) return serveSite(req, res);
    if (req.url.startsWith('/__local/')) return forwardLocal(req, res);
    const isLogin = req.url.includes('token=');
    const hasCookie = String(req.headers.cookie || '').includes('dsh-auth-');
    if (!isLogin && !hasCookie) return autoLogin(res);
    if (FAST_PATH && req.url.startsWith('/plugins/??')) return void serveCombo(req, res, appPort);
    forward(req, res, isLogin ? CLI_PORT : appPort, false);
  })
  .on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/__insp')) {
      return proxyUpgrade(req, socket, head, 9230, req.url.replace(/^\/__insp/, '') || '/', '127.0.0.1:9230');
    }
    const lm = req.url.match(/^\/__local\/(\d+)(\/.*)?$/);
    if (lm) {
      return proxyUpgrade(req, socket, head, parseInt(lm[1], 10), lm[2] || '/', '127.0.0.1:' + lm[1]);
    }
    upgradeFor(req, socket, head, appPort, req.url, null);
  })
  .listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`dsh phone proxy: :${LISTEN_PORT} -> app :${appPort} (authority ${AUTHORITY}, auto-login via cli :${CLI_PORT})`);
  });

// Tailnet listener: the phone's local forwarder connects here (plain TCP inside
// WireGuard) to reach loopback-only services like the inspector channel.
//
// This MUST NOT be a one-shot bind at startup. The plugin now keeps the tunnel
// up across app restarts, and tailscaled removes/re-adds the 100.x interface on
// every re-up. A socket bound to an address that later disappears keeps its
// state but silently stops receiving, and a socket bound before the address
// existed fails with EADDRINUSE/ENOTFOUND and never retries. Both cases leave
// loopback working while the phone gets nothing — so re-evaluate on a timer and
// rebind whenever the address set changes.
const tailHandler = (req, res) => {
  if (req.url.startsWith('/__insp')) return forwardInspector(req, res);
  if (req.url.startsWith('/__site/')) return serveSite(req, res);
  if (req.url.startsWith('/__local/')) return forwardLocal(req, res);
  if (req.url === '/__health') return healthPage(res);
  if (FAST_PATH && req.url.startsWith('/__asset/')) return serveAsset(req, res);
  if (FAST_PATH && req.url.startsWith('/plugins/??')) return void serveCombo(req, res, appPort);
  forward(req, res, appPort, false);
};
const tailUpgrade = (req, socket, head) => {
  if (req.url.startsWith('/__insp')) {
    return proxyUpgrade(req, socket, head, 9230, req.url.replace(/^\/__insp/, '') || '/', '127.0.0.1:9230');
  }
  const lm = req.url.match(/^\/__local\/(\d+)(\/.*)?$/);
  if (lm) return proxyUpgrade(req, socket, head, parseInt(lm[1], 10), lm[2] || '/', '127.0.0.1:' + lm[1]);
  upgradeFor(req, socket, head, appPort, req.url, null);
};

let tailServer = null;
let tailBoundIp = null;

function findTailIp() {
  try {
    const ifs = require('os').networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (ni.family === 'IPv4' && ni.address.startsWith('100.')) return ni.address;
      }
    }
  } catch (e) {}
  return null;
}

function closeTail() {
  const srv = tailServer;
  tailServer = null;
  tailBoundIp = null;
  if (!srv) return;
  try { srv.close(() => {}); } catch (e) {}
  try { srv.closeAllConnections && srv.closeAllConnections(); } catch (e) {}
}

function ensureTailListener() {
  const ip = findTailIp();
  if (!ip) {
    if (tailServer) { console.log('dsh phone proxy: tailnet 地址消失，释放 tailnet listener'); closeTail(); }
    return;
  }
  if (tailServer && tailBoundIp === ip) return;
  if (tailServer) closeTail();
  const srv = http.createServer(tailHandler).on('upgrade', tailUpgrade);
  srv.on('error', (e) => {
    console.error('tail listener:', e.message);
    if (tailServer === srv) closeTail();
  });
  srv.listen(LISTEN_PORT, ip, () => {
    tailBoundIp = ip;
    tailServer = srv;
    console.log(`dsh phone proxy: tailnet listener ${ip}:${LISTEN_PORT}`);
  });
}

ensureTailListener();
setInterval(ensureTailListener, 5000).unref();

// LAN fallback listener.
//
// The phone app drives its own libtailscale engine, and that engine has no
// keepalive: if Android suspends the VpnService the tunnel stays down until a
// human reopens the app. When that happens the tailnet route is dead and the
// only remaining path is the plain LAN. Binding the private IPv4s too means the
// phone can always fall back to http://<pc-lan-ip>:8124/ by putting that URL in
// 设置 → 手动地址, with no tunnel involved at all.
//
// Set DSH_PHONE_LAN=0 to disable (e.g. on an untrusted network).
const LAN_ENABLED = String(process.env.DSH_PHONE_LAN || '1') !== '0';
const lanServers = new Map();

// Same dispatch as the loopback listener, including the auto-login hop. Without
// autoLogin a plain-LAN browser would stop at the app's 401 auth fence, so the
// LAN fallback has to mint the cookie itself exactly like loopback does.
const lanHandler = (req, res) => {
  if (req.url === '/__health') return healthPage(res);
  if (req.url.startsWith('/__insp')) return forwardInspector(req, res);
  if (req.url.startsWith('/__site/')) return serveSite(req, res);
  if (req.url.startsWith('/__local/')) return forwardLocal(req, res);
  if (FAST_PATH && req.url.startsWith('/__asset/')) return serveAsset(req, res);
  const isLogin = req.url.includes('token=');
  const hasCookie = String(req.headers.cookie || '').includes('dsh-auth-');
  if (!isLogin && !hasCookie) return autoLogin(res);
  if (FAST_PATH && req.url.startsWith('/plugins/??')) return void serveCombo(req, res, appPort);
  forward(req, res, isLogin ? CLI_PORT : appPort, false);
};

function findLanIps() {
  const out = [];
  try {
    const ifs = require('os').networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        const a = ni.address;
        if (a.startsWith('100.')) continue; // tailnet, already bound above
        if (/^169\.254\./.test(a)) continue; // link-local, useless
        if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) continue;
        out.push(a);
      }
    }
  } catch (e) {}
  return out;
}

function dropLan(ip) {
  const srv = lanServers.get(ip);
  lanServers.delete(ip);
  if (!srv) return;
  try { srv.close(() => {}); } catch (e) {}
  try { srv.closeAllConnections && srv.closeAllConnections(); } catch (e) {}
}

function ensureLanListeners() {
  if (!LAN_ENABLED) return;
  const ips = findLanIps();
  for (const ip of ips) {
    if (lanServers.has(ip)) continue;
    const srv = http.createServer(lanHandler).on('upgrade', tailUpgrade);
    srv.on('error', (e) => {
      console.error('lan listener ' + ip + ': ' + e.message);
      if (lanServers.get(ip) === srv) lanServers.delete(ip);
    });
    srv.listen(LISTEN_PORT, ip, () => {
      console.log(`dsh phone proxy: 局域网 listener http://${ip}:${LISTEN_PORT}`);
    });
    lanServers.set(ip, srv);
  }
  for (const ip of [...lanServers.keys()]) {
    if (!ips.includes(ip)) dropLan(ip);
  }
}

ensureLanListeners();
setInterval(ensureLanListeners, 5000).unref();

if (FAST_PATH) {
  pruneCache();
  setInterval(pruneCache, 6 * 3600 * 1000).unref();
  console.log('dsh phone proxy: fast path on, cache ' + CACHE_ROOT);
}


// Pick the right web root up front (the process may host several).
discoverAppPort().then((port) => {
  console.log('dsh phone proxy: app port ' + port);
  // Warm the combo cache in the background so the phone's first load is a
  // plain file read instead of 86 fetch-transform-compress cycles.
  setTimeout(() => { prewarm(); }, 1500).unref();
  // The app can pick a different root after a restart; re-warm when it does.
  setInterval(() => { prewarm(); }, 60000).unref();
});
