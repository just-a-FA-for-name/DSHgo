// node --test mobile-ui.test.cjs (Edge on Windows, or set DSH_TEST_BROWSER).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const http = require('node:http');
const {once} = require('node:events');
const {createHash} = require('node:crypto');

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({data}) => {
    const message = JSON.parse(data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  };
  return {
    ws,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, {resolve, reject});
        ws.send(JSON.stringify({id: n, method, params}));
      });
    }
  };
}

test('mobile drawer layout, interaction and injection regressions', {timeout: 30000}, async t => {
  const executable = process.env.DSH_TEST_BROWSER
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!fs.existsSync(executable)) { t.skip('Set DSH_TEST_BROWSER to a Chromium browser'); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-ui-'));
  const browser = spawn(executable, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'
  ], {stdio: 'ignore', windowsHide: true});
  let browserClient, client;
  t.after(async () => {
    client?.ws.close();
    if (browserClient) {
      try { await browserClient.call('Browser.close'); } catch {}
      browserClient.ws.close();
    }
    browser.kill();
    // Only this test's freshly created, isolated profile is eligible for cleanup.
    try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); } catch {}
  });
  const activeFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(activeFile); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(fs.existsSync(activeFile), 'browser debugging endpoint started');
  const [port, socketPath] = fs.readFileSync(activeFile, 'utf8').trim().split(/\r?\n/);
  browserClient = await connect('ws://127.0.0.1:' + port + socketPath);
  const {targetId} = await browserClient.call('Target.createTarget', {url: 'about:blank'});
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  client = await connect(pages.find(page => page.id === targetId).webSocketDebuggerUrl);
  let backendAvailable = true;
  let holdProbe = false;
  let heldProbe;
  let probeCount = 0;
  let uploadHandler;
  const server = http.createServer((req, res) => {
    if (uploadHandler && req.url.startsWith('/__dsh/uploads')) return uploadHandler(req, res);
    if (req.method === 'HEAD') {
      probeCount++;
      if (holdProbe) { heldProbe = res; return; }
    }
    res.writeHead(backendAvailable ? 200 : 503, { 'content-type': 'text/html' });
    res.end('<!doctype html><body></body>');
  });
  const streamSockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/api/synthetic-stream') { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    streamSockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => streamSockets.delete(socket));
  });
  t.after(() => { for (const socket of streamSockets) socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const evaluate = async expression => {
    const result = await client.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const resize = width => client.call('Emulation.setDeviceMetricsOverride', {
    width, height: 800, deviceScaleFactor: 1, mobile: false
  });
  await resize(390);
  await client.call('Page.enable');
  await client.call('Page.navigate', {url: 'http://127.0.0.1:' + server.address().port + '/'});
  await new Promise(resolve => setTimeout(resolve, 100));
  const {frameTree} = await client.call('Page.getFrameTree');
  await client.call('Page.setDocumentContent', {frameId: frameTree.frame.id, html: `
    <!doctype html><html><head><meta name="viewport" content="width=device-width">
    <style>
      html,body{margin:0;height:100%}.fixture_frame{display:grid;height:100%;position:relative;overflow:hidden}
      .fixture_centerCol{min-width:0}.fixture_sidebarCol{min-width:0}
      .fixture_rightbarCol{min-width:0}.fixture_bottomRow{grid-column:1/-1}
    </style></head><body>
    <div class="fixture_frame" data-sidebar-collapsed data-rightbar-collapsed>
      <div class="fixture_sidebarCol"><nav aria-label="全局面板">
        <button aria-label="打开侧边栏">Menu</button>
        <div data-row-key="session:synthetic">Synthetic session<button aria-label="会话操作">More</button></div>
        <button aria-label="新建会话">New</button>
      </nav></div>
      <main class="fixture_centerCol"><textarea></textarea><input type="file" multiple></main>
      <aside class="fixture_rightbarCol"></aside><div class="fixture_bottomRow"></div>
    </div>
    <script>
      const frame=document.querySelector('.fixture_frame');
      function columns(){frame.style.gridTemplateColumns=(frame.hasAttribute('data-sidebar-collapsed')?'56px':'280px')+' minmax(0,1fr) 0px'}
      document.querySelector('nav button').onclick=()=>{frame.toggleAttribute('data-sidebar-collapsed');columns()};
      addEventListener('resize',columns);columns();
    </script></body></html>`});
  const script = fs.readFileSync(path.join(__dirname, 'res/raw/mobile_ui.js'), 'utf8');
  await evaluate('window.__dshAutoSidebar=true;' + script);
  await settle();
  const snapshot = () => evaluate(`({
    open:window.__dshSidebarOpen(),
    width:document.querySelector('.fixture_centerCol').getBoundingClientRect().width,
    screen:innerWidth,mask:getComputedStyle(document.querySelector('[data-dsh-mask]')).display
  })`);
  await t.test('collapsed conversation occupies the full screen, never zero width', async () => {
    const state = await snapshot();
    assert.equal(state.open, false);
    assert.equal(state.width, 390);
    assert.equal(state.mask, 'none');
  });
  await t.test('menu and outside tap keep the conversation full width', async () => {
    await evaluate('window.__dshToggleSidebar()');
    await settle();
    assert.deepEqual(await snapshot(), {open: true, width: 390, screen: 390, mask: 'block'});
    await evaluate("document.querySelector('[data-dsh-mask]').click()");
    await settle();
    assert.equal((await snapshot()).open, false);
    assert.equal((await snapshot()).width, 390);
  });
  await t.test('session selection closes the drawer but its action menu does not', async () => {
    await evaluate('window.__dshToggleSidebar()');
    await settle();
    await evaluate("document.querySelector('[aria-label=\"会话操作\"]').click()");
    await settle();
    assert.equal((await snapshot()).open, true);
    await evaluate("document.querySelector('[data-row-key]').click()");
    await settle();
    assert.equal((await snapshot()).open, false);
  });
  await t.test('reinjection installs no duplicate mask or style', async () => {
    await evaluate(script);
    assert.equal(await evaluate("document.querySelectorAll('[data-dsh-mask]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('#dsh-mobile-ui').length"), 1);
  });
  await t.test('fish skin switches in place without losing editor, file or touch layout', async () => {
    const result=await evaluate(`(()=>{
      const editor=document.querySelector('textarea');editor.value='skin synthetic draft';
      const transfer=new DataTransfer();transfer.items.add(new File(['synthetic'],'skin.txt'));
      const input=document.querySelector('input[type=file]');input.files=transfer.files;
      for(let i=0;i<4;i++){window.__dshSetSkin(true);window.__dshSetSkin(false);}
      window.__dshSetSkin(true);window.__dshSetSkin(true);
      const active=document.querySelectorAll('#dsh-fish-skin').length;
      window.__dshSetSkin(false);
      return {same:editor===document.querySelector('textarea'),draft:editor.value,file:input.files[0].size,
        active,removed:!document.getElementById('dsh-fish-skin'),width:document.querySelector('main').getBoundingClientRect().width};
    })()`);
    assert.equal(result.same,true);assert.equal(result.draft,'skin synthetic draft');assert.equal(result.file,9);
    assert.equal(result.active,1);assert.equal(result.removed,true);assert.ok(result.width>=380);
  });
  await t.test('disabling auto-hide and resizing cannot blank the conversation', async () => {
    await evaluate('window.__dshSetAutoSidebar(false)');
    assert.ok((await snapshot()).width > 0);
    await resize(1024);
    await settle();
    assert.ok((await snapshot()).width > 500);
    await evaluate('window.__dshSetAutoSidebar(true)');
    await resize(360);
    await settle();
    assert.equal((await snapshot()).width, 360);
  });
  await t.test('native back closes the drawer without navigation', async () => {
    await evaluate('window.__dshToggleSidebar()');
    await settle();
    assert.equal(await evaluate('window.__dshBackAction()'), 1);
    await settle();
    assert.equal((await snapshot()).open, false);
  });
  const tick = async (auto = true, refresh = true) => {
    await evaluate(`${refresh ? 'window.__dshNetworkChanged();' : ''}window.__dshConnectionState(${auto})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    return evaluate(`window.__dshConnectionState(${auto})`);
  };
  await evaluate(`window.testClock=1000;
    Object.defineProperty(performance,'now',{value:()=>window.testClock});
    window.recoveryOnlineEvents=0;
    window.recoveryOfflineEvents=0;
    window.simulateHandshake=true;
    window.unrelatedClicks=0;
    window.documentIdentity='same-document';
    document.querySelector('textarea').value='unsent synthetic draft';
    const transfer=new DataTransfer();
    transfer.items.add(new File(['synthetic'],'test.txt',{type:'text/plain'}));
    document.querySelector('input[type=file]').files=transfer.files;
    addEventListener('offline',()=>window.recoveryOfflineEvents++);
    addEventListener('online',()=>{window.recoveryOnlineEvents++;if(window.simulateHandshake)fetch('/api/health').catch(()=>{})});
    const stale=document.createElement('div');stale.role='alert';stale.textContent='连接异常 请重试';
    const button=document.createElement('button');button.textContent='重试';
    button.onclick=()=>window.unrelatedClicks++;stale.appendChild(button);document.body.appendChild(stale);`);
  await t.test('stale error text cannot override successful connectivity', async () => {
    assert.equal(await tick(), 'ok');
    assert.equal(await evaluate('window.unrelatedClicks'), 0);
  });
  await t.test('an outage automatically re-arms DSH without reload, draft loss or resending', async () => {
    backendAvailable = false;
    assert.equal(await tick(), 'bad');
    backendAvailable = true;
    await evaluate('window.testClock+=5000');
    assert.equal(await tick(), 'ok');
    assert.equal(await evaluate('window.recoveryOnlineEvents'), 1);
    assert.equal(await evaluate('window.recoveryOfflineEvents'), 1);
    assert.equal(await evaluate('window.documentIdentity'), 'same-document');
    assert.equal(await evaluate("document.querySelector('textarea').value"), 'unsent synthetic draft');
    assert.equal(await evaluate("document.querySelector('input[type=file]').files[0].name"), 'test.txt');
    assert.equal(await evaluate('window.unrelatedClicks'), 0);
  });
  await t.test('disabling auto reconnect suppresses shell recovery until re-enabled', async () => {
    backendAvailable = false;
    assert.equal(await tick(false), 'bad');
    backendAvailable = true;
    await evaluate('window.testClock+=5000');
    assert.equal(await tick(false), 'bad');
    assert.equal(await evaluate('window.recoveryOnlineEvents'), 1);
    assert.equal(await tick(true), 'ok');
    assert.equal(await evaluate('window.recoveryOnlineEvents'), 2);
  });
  await t.test('background-network callbacks cannot interrupt a healthy open stream', async () => {
    await evaluate(`new Promise((resolve,reject)=>{
      window.healthyStream=new WebSocket('ws://127.0.0.1:${server.address().port}/api/synthetic-stream');
      healthyStream.onopen=()=>resolve(true);healthyStream.onerror=reject;
    })`);
    const before=await evaluate('window.recoveryOnlineEvents');
    await evaluate('window.testClock+=5000;window.__dshNetworkChanged(true)');
    assert.equal(await tick(true,false),'ok');
    assert.equal(await evaluate('window.recoveryOnlineEvents'),before);
    assert.equal(await evaluate('healthyStream.readyState'),1);
    await evaluate('healthyStream.close()');
    await new Promise(resolve=>setTimeout(resolve,50));
    await evaluate("fetch('/api/health')");
  });
  await t.test('concurrent polls share a probe and an old timeout cannot overwrite recovery', async () => {
    holdProbe = true;
    const before = probeCount;
    await evaluate('window.__dshNetworkChanged();for(let i=0;i<20;i++)window.__dshConnectionState(true)');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(probeCount - before, 1);
    await evaluate("window.testClock+=1000;fetch('/api/health')");
    holdProbe = false;
    heldProbe.writeHead(503);
    heldProbe.end();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await tick(true, false), 'ok');
  });
  await t.test('a reachable web server alone cannot pretend the workbench session recovered', async () => {
    backendAvailable=false;
    assert.equal(await tick(),'bad');
    backendAvailable=true;
    await evaluate('window.testClock+=1000;window.simulateHandshake=false;window.__dshNetworkChanged(true)');
    assert.equal(await tick(true, false), 'reconnecting');
    await evaluate('window.testClock+=13000');
    assert.equal(await tick(), 'reconnecting');
    await evaluate("window.simulateHandshake=true;fetch('/api/health')");
    assert.equal(await tick(), 'ok');
  });
  await t.test('only the shell reconnect action is retried and attempts are rate-limited', async () => {
    await evaluate(`window.shellRetries=0;const retry=document.createElement('button');
      retry.id='shell-retry';retry.setAttribute('aria-label','连接异常，点击立即重连');
      retry.onclick=()=>window.shellRetries++;document.querySelector('nav').appendChild(retry);`);
    assert.equal(await tick(), 'reconnecting');
    assert.equal(await evaluate('window.shellRetries'), 1);
    await evaluate('for(let i=0;i<20;i++)window.__dshConnectionState(true)');
    assert.equal(await evaluate('window.shellRetries'), 1);
    await evaluate('window.testClock+=16000');
    await tick();
    assert.equal(await evaluate('window.shellRetries'), 2);
    assert.equal(await evaluate('window.unrelatedClicks'), 0);
    await evaluate("document.querySelector('#shell-retry').remove();fetch('/api/health')");
    assert.equal(await tick(), 'ok');
  });
  await t.test('WebSocket constructor constants and subclass behavior remain available', async () => {
    assert.equal(await evaluate('WebSocket.OPEN'), 1);
    assert.equal(await evaluate('WebSocket.CLOSED'), 3);
    assert.equal(await evaluate(`(()=>{
      class Child extends WebSocket {}
      const socket=new Child('ws://127.0.0.1:${server.address().port}/unused');
      socket.addEventListener('error',()=>{});
      const valid=socket instanceof Child&&socket instanceof WebSocket;
      socket.close();return valid;
    })()`), true);
  });
  await t.test('downlink heartbeats cannot hide a failed upstream round trip', async () => {
    await evaluate(`new Promise((resolve,reject)=>{
      window.syntheticStream=new WebSocket('ws://127.0.0.1:${server.address().port}/api/synthetic-stream');
      syntheticStream.onopen=()=>resolve(true);syntheticStream.onerror=reject;
    })`);
    backendAvailable = false;
    assert.equal(await tick(), 'bad');
    for (const socket of streamSockets) socket.write(Buffer.from([0x81, 0x04, 112, 105, 110, 103]));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await tick(true, false), 'bad');
    backendAvailable = true;
    await evaluate('window.testClock+=5000');
    assert.equal(await tick(), 'ok');
    await evaluate('syntheticStream.close()');
  });
  await t.test('HTTP application errors never synthesize offline events',async()=>{
    await evaluate("fetch('/api/health')");
    const before=await evaluate('window.recoveryOfflineEvents');
    for(const [status,state]of [[404,'ok'],[401,'auth'],[403,'auth'],[429,'limited'],[500,'server'],[502,'server']]){
      await evaluate(`window.__dshTransportResult('/api/synthetic-error',false,${status})`);
      assert.equal(await tick(),state);
      assert.equal(await evaluate('window.recoveryOfflineEvents'),before);
      await evaluate("fetch('/api/health')");
    }
  });
  await t.test('early WebView compatibility preserves promise subclasses, abort reason and listener cleanup',async()=>{
    const script=fs.readFileSync(path.join(__dirname,'../pc-plugin/bridge/transport.js'),'utf8').split('/* Runs before DSH boot.')[0];
    await evaluate(`window.savedResolvers=Promise.withResolvers;window.savedAny=AbortSignal.any;Promise.withResolvers=undefined;AbortSignal.any=undefined;window.bootstrapEvents=[];window.DSHDiagnostics={pageEvent:(...args)=>bootstrapEvents.push(args)};`+script);
    const result=await evaluate(`(async()=>{
      class Child extends Promise{};const task=Child.withResolvers();task.resolve(42);
      const a=new AbortController(),b=new AbortController();let added=0,removed=0;
      for(const signal of [a.signal,b.signal]){
        const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
        signal.addEventListener=(...args)=>{added++;return add(...args)};
        signal.removeEventListener=(...args)=>{removed++;return remove(...args)};
      }
      const combined=AbortSignal.any([a.signal,b.signal,a.signal]);const reason={synthetic:true};b.abort(reason);
      const already=AbortSignal.any([b.signal]);
      let rejected=false;try{AbortSignal.any([{}])}catch(e){rejected=e instanceof TypeError;}
      const resource=document.createElement('script');resource.src='/plugins/synthetic.js';document.head.appendChild(resource);resource.dispatchEvent(new Event('error'));
      return {subclass:task.promise instanceof Child,value:await task.promise,reason:combined.reason===reason,already:already.reason===reason,added,removed,rejected,numericOnly:bootstrapEvents.every(args=>args.every(Number.isInteger)),resourceError:bootstrapEvents.some(args=>args[0]===1&&args[1]===1)};
    })()`);
    assert.deepEqual(result,{subclass:true,value:42,reason:true,already:true,added:2,removed:2,rejected:true,numericOnly:true,resourceError:true});
    await evaluate('Promise.withResolvers=savedResolvers;AbortSignal.any=savedAny;');
  });
  await t.test('real upload Worker resumes after a lost acknowledgement and preserves DSH receipts', async () => {
    const pluginRoot = fs.existsSync(path.join(__dirname, '../pc-plugin')) ? '../pc-plugin' : '../dsh-phone-remote';
    const { createUploads } = require(path.join(__dirname, pluginRoot, 'bridge/resumable-upload.cjs'));
    let bytes = 0;
    let submissions = 0;
    const upstream = http.createServer(async (req, res) => {
      if (req.method === 'GET') { res.end('authenticated test root'); return; }
      submissions++;
      for await (const chunk of req) bytes += chunk.length;
      res.end(JSON.stringify({ ok: true, value: { receiptId: 'synthetic-receipt',
        file: { attachmentId: 'synthetic-file', name: 'test.bin', bytes } } }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const uploads = createUploads({ getPort: () => upstream.address().port, rewriteHeaders: h => ({ ...h }) });
    t.after(() => uploads.close());
    let loseAck = true;
    let loseCreation = true;
    const creationIds = [];
    uploadHandler = (req, res) => {
      if (req.method === 'POST' && req.url === '/__dsh/uploads') {
        const end = res.end;
        res.end = function (body, ...args) {
          try { creationIds.push(JSON.parse(body).id); } catch (_) {}
          if (loseCreation) { loseCreation = false; this.destroy(); return this; }
          return end.call(this, body, ...args);
        };
      }
      if (req.method === 'PUT' && loseAck) {
        loseAck = false;
        // Commit bytes, but lose only the reply. The Worker must read the
        // committed offset instead of appending or submitting twice.
        res.end = () => res.destroy();
      }
      void uploads.handle(req, res);
    };
    await evaluate("document.cookie='dsh-auth-test=synthetic; Path=/'");
    await evaluate(fs.readFileSync(path.join(__dirname, pluginRoot, 'bridge/transport.js'), 'utf8'));
    const result = await evaluate(`new Promise((resolve,reject)=>{
      const worker=new Worker(URL.createObjectURL(new Blob(['throw new Error("original worker should be replaced")'])),{name:'dsh-file-upload'});
      let progress=0;
      worker.onmessage=({data})=>{
        if(data.kind==='progress'){progress=data.loaded;return}
        worker.terminate();
        if(data.kind==='error')reject(new Error(data.message));
        else resolve({status:data.status,body:JSON.parse(data.body),progress});
      };
      worker.onerror=reject;
      worker.postMessage({url:location.origin+'/api/session/uploadFileBinary?sessionId=synthetic',
        body:new Blob([new Uint8Array(3*1024*1024+9)]),headers:{'content-type':'application/octet-stream'}});
    })`);
    assert.equal(result.status, 200);
    assert.equal(result.body.value.receiptId, 'synthetic-receipt');
    assert.equal(result.progress, 3 * 1024 * 1024 + 9);
    assert.equal(bytes, result.progress);
    assert.equal(submissions, 1);
    assert.ok(creationIds.length >= 2);
    assert.equal(new Set(creationIds).size, 1);
    uploadHandler = null;
  });
});
