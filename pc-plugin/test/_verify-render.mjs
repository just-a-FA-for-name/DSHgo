// 渲染烟雾测试：用极简 React 桩加载 lib/client.js，把 Panel 组件在几种真实
// 状态下各渲染一次，检查「退出账号」按钮的文案 / 禁用态 / 账号行是否正确。
//
// 这不是浏览器，不验证样式与事件，只验证"渲染不炸 + 关键文案在"。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));

// ---- 极简 React 桩 ---------------------------------------------------
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null) };
}
let slots = [];   // 每个组件的 hook 槽，按渲染顺序预置
let slotIdx = 0;
const React = {
  createElement,
  useState(init) {
    const i = slotIdx++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
    return [slots[i], (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
  },
  useRef(init) {
    const i = slotIdx++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  },
  useEffect() {},
  useCallback(fn) { return fn; },
};

// ---- module loader 桩 -------------------------------------------------
let plugin = null;
const win = {
  __ModuleLoader__: {
    load(def) {
      const module = { exports: {} };
      // factory 内部会重新赋值 module.exports 再 return，所以取返回值。
      plugin = def.factory((id) => {
        if (id === "react") return React;
        throw new Error("unexpected require: " + id);
      });
    },
  },
};
globalThis.window = win;

new Function("window", "document", readFileSync(path.join(here, "lib", "client.js"), "utf8"))(win, undefined);
if (!plugin) throw new Error("client.js 没有调用 __ModuleLoader__.load");

// ---- 从 apply() 里取出 settings.section 的渲染函数 --------------------
let renderSection = null;
plugin.apply({
  effect(fn) { fn(); },
  slots: {
    inject(_name, fn) { fn(); },
    register(_def, fn) { renderSection = fn; return () => {}; },
  },
});
if (!renderSection) throw new Error("apply() 没有注册 settings.section 渲染函数");

// ---- 展开渲染树 -------------------------------------------------------
function walk(node, out) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (typeof node !== "object") { out.push(node); return out; }
  if (typeof node.type === "function") {
    // 函数组件（这里就是 Panel）：调用它继续展开。hook 槽已由 render() 预置好。
    walk(node.type(node.props), out);
    return out;
  }
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

// settings.section 注册的是 `() => h(Panel)`，所以调用一次拿到 h(Panel)，
// 再展开就进 Panel 本体。
function render(st, err) {
  // Panel 的 hook 顺序：st, busy, msg, err, ports, confirmOut, alive
  slots = [st, "", "", err || "", { bridge: "", cli: "" }, false, { current: true }];
  slotIdx = 0;
  const el = renderSection();
  const out = [];
  walk(el, out);
  return out;
}

const flatText = (nodes) => JSON.stringify(nodes);
const buttonTexts = (nodes) => nodes.filter((n) => n.type === "button")
  .map((b) => (b.children || []).join(""));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

const baseState = {
  ok: true,
  tailscale: {
    reachable: true, error: "", backendState: "Running", authUrl: "",
    dnsName: "desktop-on8fa6l.tail12be0.ts.net", ips: ["100.95.252.104"],
    hostname: "DESKTOP-ON8FA6L",
    account: {
      userID: "1404059510237207", loginName: "Airisey@github", displayName: "Noir_",
      avatarUrl: "https://example.invalid/a.png", tailnetName: "airisey.github", loggedIn: true,
    },
    peers: [{ name: "Xiaomi 13", dns: "xiaomi-13.tail12be0.ts.net", os: "android", online: false, ips: [] }],
  },
  serve: { configured: true, port: 8124, error: "" },
  settings: { bridgePort: 8124, cliPort: 8090, serve: true, autoTailscale: true, stopOnExit: false },
  bridge: { port: 8124, cliPort: 8090, alive: true, minterAlive: true },
  loggedOut: false, loggedOutAt: 0, lastAction: "", lastActionAt: 0, lastError: "",
};

// ===== 场景 1：已登录 =====
let nodes = render(baseState);
let texts = buttonTexts(nodes);
let json = flatText(nodes);
check("已登录：渲染不抛异常", nodes.length > 0, `${nodes.length} 个元素`);
check("已登录：出现「退出账号」按钮", texts.includes("退出账号"), texts.join(" | "));
check("已登录：退出账号按钮可点", (() => {
  const b = nodes.find((n) => n.type === "button" && (n.children || []).join("") === "退出账号");
  return b && b.props.disabled === false;
})());
check("已登录：显示登录名", json.includes("Airisey@github"));
check("已登录：显示 tailnet 名", json.includes("airisey.github"));
check("已登录：头像用 img", nodes.some((n) => n.type === "img"));
check("已登录：有「已登录」徽标", json.includes("已登录\"") || json.includes("已登录"));

// ===== 场景 2：刚退出账号 =====
const outState = {
  ...baseState,
  loggedOut: true, loggedOutAt: 1_800_000_000_000,
  serve: { configured: false, port: 8124, error: "" },
  tailscale: {
    ...baseState.tailscale, backendState: "NeedsLogin", dnsName: "", ips: [], authUrl: "",
    account: { userID: "", loginName: "", displayName: "", avatarUrl: "", tailnetName: "", loggedIn: false },
    peers: [],
  },
  bridge: { port: 8124, cliPort: 8090, alive: false, minterAlive: false },
  lastAction: "logout", lastError: "",
};
nodes = render(outState);
texts = buttonTexts(nodes);
json = flatText(nodes);
const outBtn = nodes.find((n) => n.type === "button" && (n.children || []).join("").includes("退出账号"));
check("已退出：渲染不抛异常", nodes.length > 0, `${nodes.length} 个元素`);
check("已退出：退出账号按钮被禁用", !!(outBtn && outBtn.props.disabled === true));
check("已退出：显示「未登录 Tailscale」", json.includes("未登录 Tailscale"));
check("已退出：提示点连接可重新授权", json.includes("已退出账号，点「连接」可重新授权"));
check("已退出：状态显示需要登录", json.includes("需要登录"));
check("已退出：不再显示旧账号名", !json.includes("Airisey@github"));

// ===== 场景 3：完全没有 state（首屏） =====
nodes = render(null);
check("无 state：显示「正在读取状态…」", flatText(nodes).includes("正在读取状态"));

// ===== 场景 3b：minter 起不来（手机卡等待页的直接原因） =====
const minterDead = {
  ...baseState,
  bridge: {
    port: 8124, cliPort: 8090, alive: true, minterAlive: false,
    minterError: "dsh: startup failed: 2 required plugins did not activate",
    minterProfile: "dsh-phone-minter",
  },
};
nodes = render(minterDead);
json = flatText(nodes);
check("minter 失败：渲染不抛异常", nodes.length > 0, `${nodes.length} 个元素`);
check("minter 失败：显示失败摘要", json.includes("登录签发实例启动失败"));
check("minter 失败：带上 dsh 的原始报错", json.includes("2 required plugins did not activate"));
check("minter 失败：点名所用的 profile", json.includes("dsh-phone-minter"));

// minter 没在跑、但也没有错误摘要 —— 只给提示，不假装是错误
const minterDown = { ...baseState, bridge: { port: 8124, cliPort: 8090, alive: true, minterAlive: false } };
nodes = render(minterDown);
json = flatText(nodes);
check("minter 未运行：提示会卡在等待页", json.includes("登录签发实例未运行") && json.includes("重启桥接"));
check("minter 未运行：不误报失败", !json.includes("登录签发实例启动失败"));

// ===== 场景 4：读状态失败 =====
nodes = render(null, "connection refused");
json = flatText(nodes);
check("读状态失败：显示错误与重试", json.includes("读取状态失败") && json.includes("重试"), json.slice(0, 120));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }