// Run with: node --test connection.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { once } = require('node:events');
const os = require('node:os');
const {execFileSync} = require('node:child_process');

function bridge() {
  const file = path.join(__dirname, 'bridge/dsh-phone-proxy.cjs');
  const full = fs.readFileSync(file, 'utf8').replace(/\r\n/g,'\n');
  const boundary='\nhttp\n  .createServer';
  assert.ok(full.includes(boundary),'test must exclude all production listener startup');
  const source=full.split(boundary)[0];
  const context = vm.createContext({
    require: require('node:module').createRequire(file), console, Buffer, setTimeout, clearTimeout,
    setInterval, clearInterval, URL, __dirname: path.dirname(file),
    process: { env: {}, argv: [], on() {} },
  });
  vm.runInContext(source, context);
  return context;
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}

async function request(t, port, options = {}) {
  const req = http.request({ host: '127.0.0.1', port, ...options });
  req.on('error', () => {});
  t.after(() => req.destroy());
  const response = once(req, 'response');
  req.end(options.body);
  const [res] = await response;
  return res;
}

async function body(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('SSE arrives before upstream finishes and is not gzip buffered', { timeout: 4000 }, async (t) => {
  let upstream;
  const target = await listen(t, http.createServer((req, res) => {
    upstream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  }));
  const b = bridge();
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy, { headers: { 'accept-encoding': 'gzip' } });
  const [chunk] = await once(res, 'data');
  assert.equal(chunk.toString(), 'data: first\n\n');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(upstream.writableEnded, false);
  upstream.end();
});

test('gzip sends incremental data and preserves JSON content', { timeout: 4000 }, async (t) => {
  let upstream;
  const target = await listen(t, http.createServer((req, res) => {
    upstream = res;
    res.writeHead(200, { 'content-type': 'application/json', vary: 'Origin' });
    res.write('{"value":');
  }));
  const b = bridge();
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy, { headers: { 'accept-encoding': 'gzip' } });
  const gunzip = zlib.createGunzip();
  res.pipe(gunzip);
  const [first] = await once(gunzip, 'data');
  assert.equal(first.toString(), '{"value":');
  assert.equal(upstream.writableEnded, false);
  assert.match(res.headers.vary, /Origin, Accept-Encoding/);
  const rest = body(gunzip);
  upstream.end('42}');
  assert.equal(first.toString() + (await rest).toString(), '{"value":42}');
});

test('compressed HTML installs transport before DSH boot and is never cached', async t => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><script src="/boot.js"></script></head><body>测试页面</body></html>';
  const target = await listen(t, http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', etag: 'old-tag', 'cache-control': 'max-age=3600' });
    res.end(zlib.gzipSync(html));
  }));
  const b = bridge();
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy, { headers: { 'accept-encoding': 'gzip' } });
  const output = zlib.gunzipSync(await body(res)).toString('utf8');
  assert.equal(output, html.replace('<head>', '<head><script src="/__dsh/transport.js"></script>'));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.etag, undefined);
  assert.equal(res.headers['cross-origin-embedder-policy'],undefined);
  assert.equal(res.headers['cross-origin-opener-policy'],undefined);
});

test('API replies override stale upstream caching', async t => {
  const target = await listen(t, http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=86400' });
    res.end('{}');
  }));
  const b = bridge();
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy, { path: '/api/features' });
  await body(res);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('canceling a stream releases the upstream connection', { timeout: 4000 }, async (t) => {
  let upstream;
  const target = await listen(t, http.createServer((req, res) => {
    upstream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: open\n\n');
  }));
  const b = bridge();
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy);
  const closed = once(upstream, 'close');
  res.destroy();
  await closed;
  assert.equal(upstream.destroyed, true);
});

test('a reset after receiving POST does not replay the command', { timeout: 4000 }, async (t) => {
  let calls = 0;
  let received;
  const target = await listen(t, http.createServer(async (req) => {
    calls++;
    received = (await body(req)).toString();
    req.socket.destroy();
  }));
  const b = bridge();
  b.target = target;
  vm.runInContext('discoverAppPort = async () => target', b);
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, target, false)));
  const res = await request(t, proxy, { method: 'POST', body: 'command=run' });
  await body(res);
  assert.equal(res.statusCode, 503);
  assert.equal(received, 'command=run');
  assert.equal(calls, 1);
});

test('a failed GET retries once against the discovered port', { timeout: 4000 }, async (t) => {
  const target = await listen(t, http.createServer((req, res) => res.end('recovered')));
  const failed = await listen(t, http.createServer(req => req.socket.destroy()));
  const b = bridge();
  b.target = target;
  vm.runInContext('discoverAppPort = async () => target', b);
  const proxy = await listen(t, http.createServer((req, res) => b.forward(req, res, failed, false)));
  const res = await request(t, proxy);
  assert.equal((await body(res)).toString(), 'recovered');
});

test('concurrent discovery shares one scan', async () => {
  const b = bridge();
  vm.runInContext('scanAppPort = () => new Promise(resolve => { finishScan = resolve; })', b);
  const first = b.discoverAppPort();
  assert.equal(b.discoverAppPort(), first);
  b.finishScan(4505);
  assert.equal(await first, 4505);
  const second = b.discoverAppPort();
  assert.notEqual(second, first);
  b.finishScan(4506);
  assert.equal(await second, 4506);
});

test('WebSocket reset closes the other end without crashing the bridge', { timeout: 4000 }, async (t) => {
  let upstream;
  const targetServer = http.createServer();
  targetServer.on('upgrade', (req, socket) => {
    upstream = socket;
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const target = await listen(t, targetServer);
  const b = bridge();
  const proxyServer = http.createServer();
  proxyServer.on('upgrade', (req, socket, head) => b.proxyUpgrade(req, socket, head, target));
  const proxy = await listen(t, proxyServer);
  const client = net.connect(proxy, '127.0.0.1');
  t.after(() => { client.destroy(); upstream?.destroy(); });
  client.on('error', () => {});
  client.write('GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await once(client, 'data');
  const closed = once(client, 'close');
  upstream.resetAndDestroy();
  await closed;
  assert.equal(client.destroyed, true);
});

test('mobile fetch retries reads only and respects cancellation', async () => {
  const roots = ['../dsh-phone-app/res/raw', '../phone-app/res/raw'];
  const sourcePath = roots.map(p => path.resolve(__dirname, p, 'mobile_ui.js'))
    .find(p => fs.existsSync(p));
  const source = fs.readFileSync(sourcePath, 'utf8');
  const script = source.slice(source.indexOf('const originalFetch'), source.indexOf('const viewport'));
  let calls = 0;
  let failCount = 10;
  const context = vm.createContext({
    window: { fetch: async () => {
      calls++;
      if (calls <= failCount) throw new TypeError('network reset');
      return 'ok';
    }},
    setTimeout: (fn) => fn(), console,
  });
  vm.runInContext(script, context);
  await assert.rejects(context.window.fetch({ url: '/api/run', method: 'POST' }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(context.window.fetch('/api/run', { method: 'POST' }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(context.window.fetch('/api/read', { signal: { aborted: true } }));
  assert.equal(calls, 1);
  calls = 0;
  failCount = 2;
  assert.equal(await context.window.fetch('/api/read'), 'ok');
  assert.equal(calls, 3);
});

test('reinstall replaces plugin files without nesting directories', {
  skip: process.platform !== 'win32', timeout: 15000
}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-install-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const install = () => execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'install.ps1')
  ], {env: {...process.env, USERPROFILE: home}, stdio: 'pipe', timeout: 6000});
  install();
  const destination = path.join(home, '.dsh/bundles/dsh-phone-remote');
  fs.writeFileSync(path.join(destination, 'lib/index.js'), 'outdated plugin');
  install();
  assert.equal(fs.readFileSync(path.join(destination, 'lib/index.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'lib/index.js'), 'utf8'));
  assert.equal(fs.existsSync(path.join(destination, 'lib/lib')), false);
  assert.equal(fs.existsSync(path.join(destination, 'bridge/bridge')), false);
});
