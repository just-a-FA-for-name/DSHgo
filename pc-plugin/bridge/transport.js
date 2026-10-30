/* Minimal compatibility before any workbench module executes. */
(function(){
  'use strict';
  if(window.__dshBootstrapVersion)return;
  window.__dshBootstrapVersion='1.3';
  if(!Promise.withResolvers)Promise.withResolvers=function(){
    let resolve,reject;const promise=new this((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};
  };
  if(!AbortSignal.any)AbortSignal.any=function(signals){
    const list=Array.from(signals);
    for(const signal of list)if(!(signal instanceof AbortSignal))throw new TypeError('Expected AbortSignal');
    const controller=new AbortController(),listeners=new Map();
    const cleanup=()=>{for(const [signal,listener]of listeners)signal.removeEventListener('abort',listener);listeners.clear();};
    const abort=signal=>{if(!controller.signal.aborted)controller.abort(signal.reason);cleanup();};
    for(const signal of list)if(signal.aborted){abort(signal);return controller.signal;}
    for(const signal of new Set(list)){const listener=()=>abort(signal);listeners.set(signal,listener);signal.addEventListener('abort',listener,{once:true});}
    return controller.signal;
  };
  const report=(kind,detail)=>{try{window.DSHDiagnostics?.pageEvent(kind,detail);}catch(_){}};
  const category=source=>{try{const p=new URL(source,location.href).pathname;return p.startsWith('/plugins/')?1:p.startsWith('/assets/')?2:p==='/__dsh/transport.js'?3:4;}catch(_){return 4;}};
  addEventListener('error',event=>{
    if(event.target!==window){if(event.target?.tagName==='SCRIPT')report(1,category(event.target.src));}
    else report(2,event.error?.name==='TypeError'?1:event.error?.name==='SyntaxError'?2:0);
  },true);
  addEventListener('unhandledrejection',event=>report(3,event.reason?.name==='TypeError'?1:0));
  addEventListener('DOMContentLoaded',()=>report(4,document.body?1:0),{once:true});
  addEventListener('load',()=>report(5,1),{once:true});
})();
/* Runs before DSH boot. Preserve the host's Worker protocol and file receipts. */
(function () {
  'use strict';
  if (window.__dshUploadTransport || !window.Worker) return;
  window.__dshUploadTransport = '1.2';
  window.__dshUploadProtocol = 'adaptive-v1';
  window.__dshUploadCreation = 'idempotent-v1';
  // Install before DSH captures fetch for its plugin loader. A late WebView
  // onPageFinished hook cannot recover modules that already failed to load.
  if (!window.__dshReadRetry) {
    window.__dshReadRetry = true;
    const fetchRead = window.fetch;
    window.fetch = function (input, init) {
      const args = arguments;
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const safe = method === 'GET' || method === 'HEAD';
      const signal = init?.signal || input?.signal;
      const run = async attempt => {
        try {
          const response = await fetchRead.apply(window, args);
          window.__dshTransportResult?.(input, response.ok, response.status);
          return response;
        } catch (error) {
          if (error.name !== 'AbortError' && !signal?.aborted) window.__dshTransportResult?.(input, false);
          if (!safe || error.name === 'AbortError' || signal?.aborted || attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1) + Math.random() * 250));
          if (signal?.aborted) throw error;
          return run(attempt + 1);
        }
      };
      return run(0);
    };
  }
  function uploadWorker() {
    let base;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function json(url, init = {}, timeoutMs = 20000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(new URL(url, base).href, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const value = await response.json();
        if (!response.ok) {
          const error = new Error(value.error || 'Upload HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        return value;
      } finally { clearTimeout(timer); }
    }
    async function retry(operation) {
      for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
          if (attempt >= 12 || (error.status && error.status < 500 && ![408, 409, 429].includes(error.status))) throw error;
          await sleep(Math.min(15000, 1000 * 2 ** attempt));
        }
      }
    }
    self.onmessage = async ({ data: request }) => {
      let endpoint;
      try {
        const url = new URL(request.url);
        base = url.origin;
        // All other Worker requests retain DSH's ordinary one-shot transport.
        if (!(request.body instanceof Blob)) {
          const response = await fetch(url, { method: 'POST', body: request.body,
            headers: request.headers, credentials: 'same-origin', duplex: 'half' });
          self.postMessage({ kind: 'complete', status: response.status, body: await response.text() });
          return;
        }
        const requestId = Array.from(crypto.getRandomValues(new Uint8Array(24)),
          byte => byte.toString(16).padStart(2, '0')).join('');
        // Lost creation acknowledgements reuse one reservation, even when
        // several retry requests overlap on a very slow link.
        const created = await retry(() => json('/__dsh/uploads', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: url.pathname + url.search, total: request.body.size, requestId }) }));
        endpoint = '/__dsh/uploads/' + created.id;
        let offset = 0;
        // A fixed 1 MiB block can exceed a slow link's timeout repeatedly.
        // Start small, grow on fast acknowledgements, shrink after stalls.
        let chunkSize = Math.min(created.chunkSize, 128 * 1024);
        while (offset < request.body.size) {
          const start = offset;
          let sentEnd = start;
          let retried = false;
          const startedAt = performance.now();
          const status = await retry(async () => {
            const current = await json(endpoint);
            if (sentEnd > start && current.offset === sentEnd) return current; // PUT acknowledgement was lost.
            if (current.offset !== start) throw new Error('Unexpected upload offset');
            if (current.busy) {
              const error = new Error('Previous block is still settling');
              error.status = 409;
              throw error;
            }
            sentEnd = Math.min(start + chunkSize, request.body.size);
            try {
              return await json(endpoint + '?offset=' + start, { method: 'PUT',
                headers: { 'content-type': 'application/octet-stream' }, body: request.body.slice(start, sentEnd) }, 60000);
            } catch (error) {
              retried = true;
              chunkSize = Math.max(32 * 1024, Math.floor(chunkSize / 2));
              throw error;
            }
          });
          offset = status.offset;
          if (!retried) {
            const elapsed = performance.now() - startedAt;
            if (elapsed < 1500) chunkSize = Math.min(created.chunkSize, chunkSize * 2);
            else if (elapsed > 8000) chunkSize = Math.max(32 * 1024, Math.floor(chunkSize / 2));
          }
          self.postMessage({ kind: 'progress', loaded: offset, total: request.body.size });
        }
        await retry(() => json(endpoint + '/complete', { method: 'POST' }));
        for (;;) {
          const status = await retry(() => json(endpoint));
          if (status.state === 'failed') throw new Error(status.error);
          if (status.state === 'complete') {
            self.postMessage({ kind: 'complete', status: 200, body: JSON.stringify(status.result) });
            return;
          }
          await sleep(750);
        }
      } catch (error) {
        self.postMessage({ kind: 'error', message: error.message });
      }
    };
  }
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(Target, args, NewTarget) {
      if (args[1]?.name !== 'dsh-file-upload') return Reflect.construct(Target, args, NewTarget);
      const url = URL.createObjectURL(new Blob(['(' + uploadWorker.toString() + ')()'], { type: 'text/javascript' }));
      try {
        const worker=Reflect.construct(Target,[url,args[1]],NewTarget);
        worker.addEventListener('message',event=>{
          const data=event.data;
          const kind=data?.kind==='progress'?1:data?.kind==='complete'?2:data?.kind==='error'?3:0;
          if(kind){
            // Classify locally; never send the worker's raw error text or receipt.
            const message=kind===3?String(data.message||''):'';
            const reason=/timeout|timed out|abort/i.test(message)?1:/fetch|network|connection/i.test(message)?2:/401|403|auth/i.test(message)?3:/409|busy|settling/i.test(message)?4:/offset/i.test(message)?5:/desktop|upstream|502|503/i.test(message)?6:0;
            try{window.DSHDiagnostics?.signal(kind,Number.isFinite(data.loaded)?data.loaded:0,reason);}catch(_){}
          }
        });
        return worker;
      }
      finally { URL.revokeObjectURL(url); }
    }
  });
})();
