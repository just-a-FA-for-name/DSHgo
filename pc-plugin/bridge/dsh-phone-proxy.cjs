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
const { pipeline, Transform } = require('stream');
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
let appPort = Number(process.argv[2]) || null;
const { createUploads } = require('./resumable-upload.cjs');
const uploads = createUploads({ getPort: () => appPort, rewriteHeaders });
const transportScript = fs.readFileSync(path.join(__dirname, 'transport.js'));

function transportRoute(req, res) {
  if (req.url.split('?')[0] === '/__dsh/transport.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(transportScript);
    return true;
  }
  if (/^\/__dsh\/uploads(?:\/|\?|$)/.test(req.url)) {
    void uploads.handle(req, res);
    return true;
  }
  return false;
}

function injectTransport() {
  let prefix = Buffer.alloc(0);
  let injected = false;
  const tag = '<script src="/__dsh/transport.js"></script>';
  return new Transform({
    transform(chunk, encoding, callback) {
      if (injected) return callback(null, chunk);
      prefix = Buffer.concat([prefix, chunk]);
      // ASCII header matching preserves UTF-8 sequences split across chunks.
      const match = /<head(?:\s[^>]*)?>/i.exec(prefix.toString('latin1'));
      if (match) {
        const offset = match.index + match[0].length;
        this.push(prefix.subarray(0, offset));
        this.push(tag);
        this.push(prefix.subarray(offset));
      } else if (prefix.length < 65536) return callback();
      else { this.push(tag); this.push(prefix); }
      prefix = Buffer.alloc(0);
      injected = true;
      callback();
    },
    flush(callback) {
      if (!injected) { this.push(tag); this.push(prefix); }
      callback();
    }
  });
}

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
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DISCOVER], { timeout: 10000, windowsHide: true }, async (err, out) => {
      const cands = String(out || '').split(/\s+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
      if (!cands.length) return resolve(null);
      // The app process can host several web roots, each with its own signing
      // secret. Pick the root the minter's cookie actually unlocks: mint one
      // and probe GET / — the wrong root answers 401 even with a valid cookie.
      let pair = null;
      try { pair = await mintCookie(); } catch {}
      if (!pair) return resolve(null); // minter not ready yet — caller retries
      for (const port of cands) {
        if (port === CLI_PORT || port === LISTEN_PORT) continue;
        const ok = await new Promise((res) => {
          const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', headers: { host: AUTHORITY, origin: 'http://' + AUTHORITY, cookie: pair } }, (up) => { up.resume(); res(up.statusCode === 200); });
          req.on('error', () => res(false));
          req.setTimeout(3000, () => { req.destroy(); res(false); });
          req.end();
        });
        if (ok) return resolve(port);
      }
      resolve(null);
    });
  });
  // Retry for a while: at startup the minter may not have printed its token yet,
  // and picking a wrong/guessed port sticks until the next failure.
  for (let i = 0; i < 3; i++) {
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
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' });
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5"><title>等待桌面 App</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;text-align:center;padding:0 24px}</style>
</head><body><div><h2>正在等待电脑上的 DSH 桌面 App…</h2>
<p>${note || 'App 未启动或还在启动中，本页每 5 秒自动重试。'}</p>
<p>若长时间没有反应，请确认电脑 DSH 已运行且 dsh-phone-remote 插件已启用。</p></div></body></html>`);
}

function forward(req, res, targetPort, retried) {
  if (res.destroyed || res.writableEnded) return;
  if (!targetPort) {
    if (retried || !['GET', 'HEAD'].includes(req.method)) return waitingPage(res, '正在识别桌面工作台，尚未提交此请求。');
    discoverAppPort().then(port => forward(req, res, port, true));
    return;
  }
  // A consumed request body cannot be replayed. Never retry commands/uploads.
  const canRetry = !retried && (req.method === 'GET' || req.method === 'HEAD')
    && !req.headers['transfer-encoding'] && !Number(req.headers['content-length']);
  const upstream = http.request(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: rewriteHeaders(req.headers) },
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
            if (p && p !== targetPort && !res.destroyed) return forward(req, res, p, true);
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
      // Preserve upstream policy. Forced COEP can block credentialed plugin
      // resources in WebView without actually enabling crossOriginIsolated.
      if (/text\/html/.test(type)) {
        if(process.env.DSH_PHONE_CROSS_ORIGIN_ISOLATION==='1'){
          headers['cross-origin-opener-policy']='same-origin';
          headers['cross-origin-embedder-policy']='credentialless';
        }
        headers['cache-control'] = 'no-store';
        // Install upload transport before any DSH plugin captures Worker.
        if (req.method !== 'HEAD' && up.statusCode === 200 && ['','gzip','br','deflate'].includes(enc)) {
          delete headers['content-length'];
          delete headers['content-encoding'];
          delete headers.etag;
          headers['cross-origin-resource-policy'] = 'cross-origin';
          const streams = [up];
          if (enc === 'gzip') streams.push(zlib.createGunzip());
          if (enc === 'br') streams.push(zlib.createBrotliDecompress());
          if (enc === 'deflate') streams.push(zlib.createInflate());
          streams.push(injectTransport());
          if (wantsGzip) {
            headers['content-encoding'] = 'gzip';
            headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
            streams.push(zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }));
          }
          res.writeHead(up.statusCode, headers);
          pipeline(...streams, res, () => {});
          return;
        }
      }
      if (/^\/api\//.test(req.url)) headers['cache-control'] = 'no-store';
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
  // This is inactivity, not a total transfer deadline. Slow uploads can last
  // much longer than 30 seconds; progress and backpressure must keep flowing.
  upstream.setTimeout(120000, () => upstream.destroy(new Error('upstream response timeout')));
  res.once('close', () => upstream.destroy());
  req.once('aborted', () => upstream.destroy());
  if (retried) upstream.end();
  else req.pipe(upstream);
}

// The rewritten /__insp path routes to the app's local resource/inspector port.
function forwardInspector(req, res) {
  const target = { host: '127.0.0.1', port: 9230, method: req.method, path: req.url.replace(/^\/__insp/, '') || '/', headers: { ...req.headers, host: '127.0.0.1:9230', origin: 'http://127.0.0.1:9230' } };
  const up = http.request(target, (u) => {
    res.writeHead(u.statusCode, u.headers);
    u.on('error', () => res.destroy());
    u.pipe(res);
  });
  up.on('error', () => waitingPage(res));
  up.setTimeout(120000, () => up.destroy());
  res.once('close', () => up.destroy());
  req.once('aborted', () => up.destroy());
  req.pipe(up);
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

function proxyUpgrade(req, socket, head, port, pathOverride, hostHeader) {
  const headers = rewriteHeaders(req.headers);
  headers['connection'] = 'Upgrade';
  headers['upgrade'] = req.headers.upgrade || 'websocket';
  if (hostHeader) { headers['host'] = hostHeader; headers['origin'] = 'http://' + hostHeader; }
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

const handlePhoneRequest = (req, res) => {
    if (transportRoute(req, res)) return;
    if (req.url.startsWith('/__insp')) return forwardInspector(req, res);
    if (req.url.startsWith('/__site/')) return serveSite(req, res);
    if (req.url.startsWith('/__local/')) return forwardLocal(req, res);
    const isLogin = req.url.includes('token=');
    const hasCookie = String(req.headers.cookie || '').includes('dsh-auth-');
    if (!isLogin && !hasCookie) {
      if (req.method === 'GET' || req.method === 'HEAD') return autoLogin(res);
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: '登录已失效，请重新连接后再发送。' }));
    }
    forward(req, res, isLogin ? CLI_PORT : appPort, false);
  }
const handlePhoneUpgrade = (req, socket, head) => {
    if (!appPort && !req.url.startsWith('/__')) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    if (req.url.startsWith('/__insp')) {
      return proxyUpgrade(req, socket, head, 9230, req.url.replace(/^\/__insp/, '') || '/', '127.0.0.1:9230');
    }
    const lm = req.url.match(/^\/__local\/(\d+)(\/.*)?$/);
    if (lm) {
      return proxyUpgrade(req, socket, head, parseInt(lm[1], 10), lm[2] || '/', '127.0.0.1:' + lm[1]);
    }
    proxyUpgrade(req, socket, head, appPort, req.url, null);
  }

http
  .createServer(handlePhoneRequest)
  .on('upgrade', handlePhoneUpgrade)
  .on('listening', function () { this.requestTimeout = 0; this.keepAliveTimeout = 65000; })
  .listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`dsh phone proxy: :${LISTEN_PORT} -> app :${appPort} (authority ${AUTHORITY}, auto-login via cli :${CLI_PORT})`);
  });

// Tailnet listener: the phone's local forwarder connects here (plain TCP inside
// WireGuard) to reach loopback-only services like the inspector channel.
try {
  const os = require('os');
  const ifs = os.networkInterfaces();
  let tailIp = null;
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && ni.address.startsWith('100.')) { tailIp = ni.address; break; }
    }
    if (tailIp) break;
  }
  if (tailIp) {
    const tail = http.createServer(handlePhoneRequest).on('upgrade', handlePhoneUpgrade);
    tail.on('error', (e) => console.error('tail listener:', e.message));
    tail.requestTimeout = 0;
    tail.keepAliveTimeout = 65000;
    tail.listen(LISTEN_PORT, tailIp, () => {
      console.log(`dsh phone proxy: tailnet listener ${tailIp}:${LISTEN_PORT}`);
    });
  }
} catch (e) {
  console.error('tail listener setup:', e.message);
}

// Pick the right web root up front (the process may host several).
discoverAppPort().then((port) => console.log('dsh phone proxy: app port ' + port));
