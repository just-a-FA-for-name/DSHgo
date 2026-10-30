(function () {
  'use strict';
  if (!document.body) return; // Native resource callbacks can precede the DOM.
  if (window.__dshAdapted) {
    window.__dshSetAutoSidebar(window.__dshAutoSidebar);
    window.__dshSetSkin?.(window.__dshFishSkin === true);
    return;
  }
  window.__dshAdapted = true;
  window.__dshProbeRoundTripOnly = true;

  window.__dshSetSkin = function(fish) {
    let skin = document.getElementById('dsh-fish-skin');
    document.documentElement.toggleAttribute("data-dsh-fish",!!fish);
    if(!fish) { skin?.remove(); return; }
    if(skin) return;
    skin = document.createElement('style'); skin.id='dsh-fish-skin';
    skin.textContent = `
      html[data-dsh-fish] ::selection { background:#8ebcff66; }
      html[data-dsh-fish] textarea:focus-visible, html[data-dsh-fish] [contenteditable=true]:focus-visible { outline:2px solid #6d9fe0; outline-offset:3px; border-radius:12px; }
      html[data-dsh-fish] [data-dsh-sidebar] { border-inline-end:1px solid #6d9fe055; background-image:linear-gradient(145deg,#6698dc14,#b2d9fc22); }
      html[data-dsh-fish] nav[aria-label="全局面板"]::before, html[data-dsh-fish] nav[aria-label="Global panel"]::before {
        content:'大肥鱼的工作台'; display:block; flex-shrink:0; min-height:46px; line-height:46px;
        padding-inline-start:52px; margin:8px; font-size:13px; font-weight:600; border-radius:16px;
        background: url('/__dsh/android-skin/mascot.png') 8px center/36px 36px no-repeat,linear-gradient(110deg,#80a9df22,#aacdec11);
      }
      html[data-dsh-fish] [class*="_card"]:has([contenteditable=true],textarea) {
        border:1px solid #7da4d15c; box-shadow:0 4px 20px #3367a419; background-image:linear-gradient(150deg,#acd1ff13,#daeaff06);
      }
      html[data-dsh-fish] [class*="_card"]:has([contenteditable=true],textarea)::before {
        content:'大肥鱼的投喂口'; display:block; pointer-events:none; height:24px; line-height:24px;
        padding-inline-start:30px; margin-bottom:6px; font-size:11px; letter-spacing:.04em; color:#6b88ad;
        background:url('/__dsh/android-skin/mascot.png') left center/24px 24px no-repeat;
      }
      html[data-dsh-fish] button:active { transform:scale(.97); }
      html[data-dsh-fish] * { scrollbar-color:#799bc1 transparent; scrollbar-width:thin; }
    `;
    document.head.appendChild(skin);
  };
  window.__dshSetSkin(window.__dshFishSkin === true);

  // Retry reads only; preserve cancellation and never replay messages/uploads.
  const originalFetch = window.fetch;
  if (!window.__dshReadRetry) {
  window.__dshReadRetry = true;
  window.fetch = function (input, init) {
    const args = arguments;
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const safe = method === 'GET' || method === 'HEAD';
    const signal = (init && init.signal) || (input && input.signal);
    const run = n => originalFetch.apply(window, args).then(response => {
      // Validation, unsupported features and user errors are not outages.
      window.__dshTransportResult?.(input, response.ok, response.status);
      return response;
    }).catch(error => {
      if (error.name !== 'AbortError' && !(signal && signal.aborted)) {
        window.__dshTransportResult?.(input, false);
      }
      if (!safe || error.name === 'AbortError' || (signal && signal.aborted) || n <= 0) throw error;
      return new Promise(resolve => setTimeout(resolve, 500 * (3 - n) + Math.random() * 250))
        .then(() => {
          if (signal && signal.aborted) throw error;
          return run(n - 1);
        });
    });
    return run(2);
  };
  }

  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  const style = document.createElement('style');
  style.id = 'dsh-mobile-ui';
  style.textContent = `
    html { -webkit-text-size-adjust: 100%; }
    body { -webkit-tap-highlight-color: transparent; overscroll-behavior: contain; }
    input, textarea, [contenteditable="true"] { font-size: 16px !important; }
    button { touch-action: manipulation; }
    button:active { opacity: .7; }
    [data-dsh-mask] { display: none; }
    @media (max-width: 759px) {
      html[data-dsh-drawer] [data-dsh-frame] {
        grid-template-columns: 0 minmax(0, 1fr) 0 !important;
        transition: none !important;
      }
      /* Absolute-positioned drawers no longer consume grid cells. Keep the
         conversation explicitly in column 2, not the zero-width first column. */
      html[data-dsh-drawer] [data-dsh-frame] > [class*="_centerCol"] {
        grid-column: 2; grid-row: 1; min-width: 0;
      }
      html[data-dsh-drawer] [data-dsh-sidebar] {
        position: absolute !important; inset: 0 auto 0 0; z-index: 31;
        width: min(86vw, 320px) !important; max-width: 100%;
        box-shadow: 8px 0 24px #0003;
      }
      html[data-dsh-drawer] [data-dsh-frame][data-sidebar-collapsed] [data-dsh-sidebar] {
        visibility: hidden; pointer-events: none; transform: translateX(-100%);
      }
      html[data-dsh-drawer] [data-dsh-sidebar] > * { width: 100% !important; }
      html[data-dsh-drawer] [data-dsh-frame]:not([data-sidebar-collapsed]) > [data-dsh-mask] {
        display: block; position: absolute; inset: 0; z-index: 30;
        background: #0006; border: 0; padding: 0; border-radius: 0;
      }
      html[data-dsh-drawer] [data-dsh-frame] > [class*="_handle"] { display: none; }
      html[data-dsh-drawer] [data-dsh-frame] > [class*="_rightbarCol"] {
        position: absolute; inset: 0; width: 100% !important; z-index: 20;
      }
      html[data-dsh-drawer] [data-dsh-frame][data-rightbar-collapsed] > [class*="_rightbarCol"] {
        visibility: hidden; pointer-events: none;
      }
      [data-dsh-dialog] { max-width: calc(100vw - 24px) !important; max-height: 90dvh !important; }
      [data-dsh-dialog-row] { flex-direction: column !important; overflow-y: auto; }
      [data-dsh-dialog-row] > * {
        width: 100% !important; min-width: 0 !important; max-width: 100% !important;
        height: auto !important; flex: 0 0 auto !important;
      }
    }
  `;
  document.head.appendChild(style);

  const narrow = matchMedia('(max-width: 759px)');
  const navSelector = 'nav[aria-label="全局面板"],nav[aria-label="Global panel"]';
  let nav, frame, toggle;
  let auto = window.__dshAutoSidebar !== false;
  let frameObserver;
  let pending = 0;
  const added = new Set();
  const dialogs = new Set();
  function findToggle() {
    if (toggle && toggle.isConnected) return toggle;
    toggle = Array.from(document.querySelectorAll('button[aria-label],button[title]')).find(button => {
      const text = (button.getAttribute('aria-label') || '') + (button.title || '');
      return (/侧边栏/.test(text) && !/右侧/.test(text)) || /^(Open|Close|Toggle) sidebar/i.test(text);
    });
    return toggle;
  }
  function sidebarOpen() {
    return !!(frame && frame.isConnected && !frame.hasAttribute('data-sidebar-collapsed'));
  }
  function closeSidebar() {
    const button = findToggle();
    if (sidebarOpen() && button) button.click();
  }
  function syncSidebar() {
    const button = findToggle();
    if (button) button.setAttribute('aria-expanded', String(sidebarOpen()));
  }
  function attachSidebar() {
    if (frame && frame.isConnected) return;
    nav = document.querySelector(navSelector);
    if (!nav) return;
    const column = nav.closest('[class*="_sidebarCol"]');
    if (!column || !column.parentElement) return;
    frame = column.parentElement;
    frame.setAttribute('data-dsh-frame', '');
    column.setAttribute('data-dsh-sidebar', '');
    toggle = null;
    const mask = document.createElement('button');
    mask.setAttribute('data-dsh-mask', '');
    mask.setAttribute('aria-label', '关闭会话侧边栏');
    mask.tabIndex = -1;
    mask.addEventListener('click', closeSidebar);
    frame.appendChild(mask);
    if (frameObserver) frameObserver.disconnect();
    frameObserver = new MutationObserver(syncSidebar);
    frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
    if (auto && narrow.matches) closeSidebar();
    syncSidebar();
  }
  window.__dshToggleSidebar = function () {
    attachSidebar();
    const button = findToggle();
    if (!button) return false;
    button.click();
    return true;
  };
  window.__dshSidebarOpen = sidebarOpen;
  window.__dshBackAction = function () {
    if (!sidebarOpen()) return 0;
    closeSidebar();
    return 1;
  };
  window.__dshSetAutoSidebar = function (value) {
    const enabling = !auto && value !== false;
    auto = value !== false;
    document.documentElement.toggleAttribute('data-dsh-drawer', auto);
    attachSidebar();
    if (enabling && narrow.matches) closeSidebar();
  };

  // Delegate selection to the workbench first, then dismiss only the drawer.
  document.addEventListener('click', event => {
    if (!auto || !narrow.matches || !nav || !sidebarOpen()) return;
    const target = event.target;
    if (!(target instanceof Element) || !nav.contains(target)) return;
    const row = target.closest('[data-row-key^="session:"]');
    const newChat = target.closest('button[aria-label="新建会话"],button[aria-label="New session"]');
    if ((row && !target.closest('button,[role="button"],input')) || newChat) {
      requestAnimationFrame(closeSidebar);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebarOpen()) closeSidebar();
  });

  // Inspect newly inserted dialog nodes only, not every element on each streamed token.
  const dialogSelector = '[role="dialog"],[class*="_panel"]';
  function registerDialogs(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(dialogSelector)) dialogs.add(root);
    for (const dialog of root.querySelectorAll(dialogSelector)) dialogs.add(dialog);
  }
  function adaptDialogs() {
    if (!narrow.matches) return;
    for (const dialog of dialogs) {
      if (!dialog.isConnected) { dialogs.delete(dialog); continue; }
      if (dialog.querySelector(navSelector) || !dialog.getClientRects().length) continue;
      dialog.setAttribute('data-dsh-dialog', '');
      // Settings use a two-column panel. Inspect immediate rows, never its full subtree.
      for (const row of [dialog, ...dialog.children]) {
        if (row.children.length < 2 || row.hasAttribute('data-dsh-dialog-row')) continue;
        const css = getComputedStyle(row);
        if (css.display !== 'flex' || css.flexDirection !== 'row') continue;
        const first = row.firstElementChild.getBoundingClientRect();
        if (first.width > 100 && first.height > 150) row.setAttribute('data-dsh-dialog-row', '');
      }
    }
  }
  function flush() {
    pending = 0;
    attachSidebar();
    for (const root of added) if (root.isConnected) registerDialogs(root);
    added.clear();
    adaptDialogs();
  }
  const observer = new MutationObserver(records => {
    if (document.hidden) return;
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1) added.add(node);
    }
    if (added.size && !pending) pending = requestAnimationFrame(flush);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  narrow.addEventListener('change', () => {
    if (auto && narrow.matches) closeSidebar();
    adaptDialogs();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      attachSidebar();
      registerDialogs(document.body);
      adaptDialogs();
    }
  });

  // Prevent session changes from summoning the keyboard, while keeping touch,
  // keyboard navigation and selection in the active editor functional.
  let inputIntentAt = 0;
  const editable = element => element instanceof Element
    && (element.matches('input:not([type="file"]),textarea') || element.isContentEditable);
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Element
        && (editable(event.target) || event.target.closest('[contenteditable="true"]'))) {
      inputIntentAt = performance.now();
    }
  }, { capture: true, passive: true });
  document.addEventListener('keydown', () => { inputIntentAt = performance.now(); }, true);
  const originalFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function () {
    if (editable(this) && !editable(document.activeElement) && performance.now() - inputIntentAt > 700) return;
    return originalFocus.apply(this, arguments);
  };

  // Reachability and the workbench's own reconnect action, never conversation
  // text or arbitrary alert/retry buttons. The native poll owns scheduling.
  let reachable = null;
  let probe = null;
  let nextProbeAt = 0;
  let needsRecovery = false;
  let recoveryAttempt = 0;
  let nextRecoveryAt = 0;
  let recoveringAt = 0;
  let lastApiSuccessAt = 0;
  let allowRecovery = true;
  let dispatchingRecovery = false;
  let recoveryDispatched=false;
  let httpProblem="";
  const now = () => performance.now();
  const retrySelector = [
    'button[aria-label="连接异常，点击立即重连"]',
    'button[aria-label="连接中断，正在重试，点击立即重连"]',
    'button[aria-label="Connection error, click to reconnect now"]',
    'button[aria-label="Connection interrupted, retrying. Click to reconnect now"]'
  ].join(',');
  function connectionRetryButton() {
    // A message can quote the same words; only shell-owned controls qualify.
    return document.querySelector('nav[aria-label="全局面板"]')
      ?.querySelector(retrySelector)
      || document.querySelector('[data-slot="sidebar.settings"]')?.querySelector(retrySelector);
  }
  function failed() {
    reachable = false;
    needsRecovery = true;
    nextProbeAt = Math.min(nextProbeAt, now() + 2000);
  }
  function recovered() {
    recoveryDispatched=false;
    needsRecovery = false;
    recoveryAttempt = 0;
    recoveringAt = 0;
    nextRecoveryAt = 0;
  }
  window.__dshTransportResult = function (input, ok, status=0) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
    catch (_) { return; }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return;
    if(status>0&&!ok){
      // A server response proves transport reachability. Authentication,
      // throttling and application errors must not tear down a healthy stream.
      reachable=true;
      httpProblem=status===401||status===403?'auth':status===429?'limited':status>=500?'server':'';
      return;
    }
    if (ok) {
      httpProblem='';
      lastApiSuccessAt = now();
      reachable = true;
      if (!connectionRetryButton()) recovered();
    } else {
      failed();
    }
  };
  function reconnectWorkbench() {
    if (!allowRecovery || document.hidden || reachable !== true || !needsRecovery
        || now() < nextRecoveryAt) return;
    const button=connectionRetryButton();
    if(recoveryDispatched&&!button)return;
    recoveringAt = now();
    nextRecoveryAt = recoveringAt + Math.min(45000, 15000 * 2 ** Math.min(recoveryAttempt++, 2))
      + Math.random() * 500;
    dispatchingRecovery = true;
    try {
      recoveryDispatched=true;
      if (button && !button.disabled) {
        button.click(); // Calls DSH's connection.reconnect(), never a business action.
      } else {
        // DSH's Connection service subscribes to browser network events. Re-arm
        // the existing generation without reloading or resending any message.
        dispatchEvent(new Event('offline'));
        dispatchEvent(new Event('online'));
      }
    } finally {
      dispatchingRecovery = false;
    }
  }
  async function checkReachability() {
    if (probe || document.hidden || now() < nextProbeAt) return;
    const controller = new AbortController();
    probe = controller;
    const startedAt = now();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const url = new URL('./', location.href);
      url.search = '';
      url.hash = '';
      const options = { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: controller.signal };
      let response = await originalFetch.call(window, url.href, options);
      if (response.status === 405 || response.status === 501) {
        response = await originalFetch.call(window, url.href, { ...options, method: 'GET' });
      }
      response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error('workbench unreachable');
      if (reachable === false) {
        needsRecovery = true;
        nextRecoveryAt = 0; // Physical connectivity returned: do not wait out old backoff.
      }
      reachable = true;
      reconnectWorkbench();
    } catch (_) {
      if (!document.hidden && lastApiSuccessAt <= startedAt) failed();
    } finally {
      clearTimeout(timer);
      if (probe === controller) probe = null;
      nextProbeAt = now() + (reachable === true && !needsRecovery ? 15000 : 3000);
    }
  }
  addEventListener('offline', () => {
    if (!dispatchingRecovery) { failed(); nextProbeAt = 0; }
  });
  addEventListener('online', () => {
    if (!dispatchingRecovery) nextProbeAt = 0;
  });
  window.__dshNetworkChanged = function (reconnect = false) {
    nextProbeAt = 0;
    if (reconnect && (reachable===false||connectionRetryButton())) needsRecovery = true;
  };
  // Keep native WebSocket constants, prototype and subclass behavior intact.
  // Observe only same-origin DSH streams, never inspector/third-party sockets
  // and never their payloads.
  const NativeWebSocket = window.WebSocket;
  let latestSocket;
  if (NativeWebSocket) window.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args, NewTarget) {
      const socket = Reflect.construct(Target, args, NewTarget);
      try {
        const url = new URL(args[0], location.href);
        if (url.host === location.host && /^\/api(?:\/|$)/.test(url.pathname)) {
          latestSocket = socket;
          socket.addEventListener('message', () => {
            if (latestSocket !== socket) return;
            // A one-way outage can still deliver queued server heartbeats.
            // Those messages cannot disprove a failed HTTP round trip, or
            // suppress the timeout of a probe that is still waiting.
            if (reachable !== true) { nextProbeAt = 0; return; }
            if (!connectionRetryButton()) recovered();
          });
          socket.addEventListener('close', () => {
            if (latestSocket === socket && (!recoveringAt || now() - recoveringAt > 12000)) failed();
          });
        }
      } catch (_) {}
      return socket;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) probe?.abort();
    else nextProbeAt = 0;
  });
  window.__dshConnectionState = function (autoReconnect = true) {
    // A 200 HTML bootstrap is not proof that its JavaScript/plugins mounted.
    if (!document.querySelector(navSelector)
        && !document.querySelector('textarea,[contenteditable="true"]')) return 'loading';
    allowRecovery = autoReconnect;
    const retry = connectionRetryButton();
    if (retry) needsRecovery = true;
    // A successful API/stream response is stronger evidence than a leftover
    // generic alert. Time passing alone is never proof of recovery.
    if (reachable === true && !retry && needsRecovery && recoveringAt
        && lastApiSuccessAt > recoveringAt) recovered();
    void checkReachability();
    reconnectWorkbench();
    if (reachable === false) return 'bad';
    if(httpProblem)return httpProblem;
    if (needsRecovery) return allowRecovery ? 'reconnecting' : 'bad';
    return reachable === true ? 'ok' : 'weak';
  };
  window.__dshSetAutoSidebar(auto);
  registerDialogs(document.body);
  adaptDialogs();
})();
