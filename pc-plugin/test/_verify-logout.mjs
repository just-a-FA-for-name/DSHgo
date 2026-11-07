// 一次性验证脚本：把 registerUiRoutes 挂到一个假 webServer 上，然后真的打
// /state、/logout、/up 三条路由，检查返回与副作用。
//
// 注意：这里会真的调用 tailscale.exe。为了避免把当前这台机器的登录态退掉，
// 默认用 TS_STUB 指定的假 tailscale（一个 node 脚本）代替真二进制；
// 只有显式 --real 时才碰真 tailscale（那会真的退出账号，别乱跑）。
import http from "node:http";
import { writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerUiRoutes } from "../lib/ui-routes.js";

const real = process.argv.includes("--real");

// ---- 假 tailscale ----------------------------------------------------
// 用一个记录调用的桩：状态可被 /logout 改写，用来验证"退出后 state 变成未登录"。
const stubDir = path.join(os.homedir(), ".dsh", "logs", "_ts-stub");
const stubState = path.join(stubDir, "state.json");
import { mkdirSync, readFileSync, existsSync } from "node:fs";
mkdirSync(stubDir, { recursive: true });
// 每次都重置成「已登录」，否则上一轮跑完（它会把桩改成未登录）会让这一轮从
// NeedsLogin 起步，前几个断言全部对不上。
writeFileSync(stubState, JSON.stringify({
  haveNodeKey: true,
  backendState: "Running",
  selfUser: "1404059510237207",
  user: { "1404059510237207": { LoginName: "Airisey@github", DisplayName: "Noir_" } },
}), "utf8");
writeFileSync(path.join(stubDir, "calls.log"), "", "utf8");
const stubScript = path.join(stubDir, "tailscale-stub.cjs");
writeFileSync(stubScript, `
const fs = require("node:fs");
const f = ${JSON.stringify(stubState)};
const s = JSON.parse(fs.readFileSync(f, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(stubDir, "calls.log"))}, JSON.stringify(argv) + "\\n");
if (argv[0] === "status") {
  process.stdout.write(JSON.stringify({
    Version: "stub", BackendState: s.backendState, HaveNodeKey: s.haveNodeKey,
    Self: { UserID: Number(s.selfUser), HostName: "STUBHOST", DNSName: "stub.tail0.ts.net." },
    TailscaleIPs: ["100.64.0.1"], User: s.user, CurrentTailnet: { Name: "stub-tailnet" }, Peer: {},
  }));
  process.exit(0);
}
if (argv[0] === "logout") {
  s.haveNodeKey = false; s.backendState = "NeedsLogin"; s.user = {}; s.selfUser = "";
  fs.writeFileSync(f, JSON.stringify(s));
  process.stderr.write("Logged out.\\n");
  process.exit(0);
}
if (argv[0] === "up") { s.backendState = "Running"; s.haveNodeKey = true; fs.writeFileSync(f, JSON.stringify(s)); process.exit(0); }
if (argv[0] === "down") { s.backendState = "Stopped"; fs.writeFileSync(f, JSON.stringify(s)); process.exit(0); }
if (argv[0] === "serve") { process.stdout.write("{}"); process.exit(0); }
if (argv[0] === "set") process.exit(0);
process.exit(0);
`, "utf8");

const tsBin = real ? "C:\\Program Files\\Tailscale\\tailscale.exe" : process.execPath;
const stubArgsPrefix = real ? [] : [stubScript];

// ---- 假 webServer ----------------------------------------------------
let mounted = null;
const webServer = {
  register(opts) { mounted = opts; return () => { mounted = null; }; },
};

// registerUiRoutes 只会 execFile(tsBin, [...args])，桩需要多一个脚本参数；
// 用 process.execPath + 一个包装环境变量做不到，所以这里直接改 cfg.tailscaleBin
// 指向一个 .cmd 包装（Windows 下 execFile 能跑 .cmd 吗？不一定）。
// 更稳的办法：桩写成 .exe 不可行，于是用 node 的 --eval 包一层 shell 脚本。
// Windows 上 execFile 执行 .cmd 需要 shell，所以最终选：写一个 .bat 并且
// 把 tailscaleBin 指到 cmd.exe /c 的组合 —— 也不行（参数会错位）。
//
// 结论：直接调用被测模块不方便换 bin。改为在进程内给 execFile 打补丁。
// （见下面 stubExecFile）
const cfg = {
  tailscaleBin: "TAILSCALE_STUB",
  bridgePort: 8124,
  cliPort: 8090,
  serve: true,
  autoTailscale: true,
  stopOnExit: false,
  paused: false,
  loggedOutCalls: 0,
  saveConfig: () => ({ ok: true, message: "stub" }),
  applyRuntime: () => {},
  restart: async () => ({ ok: true, message: "stub restart" }),
  afterLogout: async () => { cfg.paused = true; cfg.loggedOutCalls++; },
  getPaused: () => cfg.paused,
  setPaused: (v) => { cfg.paused = v === true; },
  setAutoUp: () => {},
  resumeTunnel: () => { cfg.paused = false; return { ok: true, message: "resumed" }; },
};

// 拦截 child_process.execFile：node: 内置模块的 ESM 导出是只读的，改不动。
// 所以走到另一条路 —— 把 ui-routes 的源码读出来，替换 import 行后动态加载。
const cp = await import("node:child_process");
const realExecFile = cp.execFile;

const src = readFileSync(new URL("../lib/ui-routes.js", import.meta.url), "utf8");
const patched = src
  .replace('import { execFile } from "node:child_process";',
           'const execFile = globalThis.__TS_EXEC__;')
  .replace('import { existsSync, readFileSync } from "node:fs";',
           'import { existsSync, readFileSync } from "node:fs";');
if (!patched.includes("globalThis.__TS_EXEC__")) {
  console.error("patch failed: import line not found");
  process.exit(1);
}
globalThis.__TS_EXEC__ = function (bin, args, opts, cb) {
  const target = bin === "TAILSCALE_STUB" ? process.execPath : bin;
  const argv = bin === "TAILSCALE_STUB" ? [stubScript, ...args] : args;
  return realExecFile(target, argv, opts, cb);
};
writeFileSync(path.join(stubDir, "ui-routes.patched.mjs"), patched, "utf8");
const { registerUiRoutes: reg } = await import(
  "file:///" + path.join(stubDir, "ui-routes.patched.mjs").replace(/\\/g, "/")
);

const mod = reg({ webServer }, cfg);
if (!mod) { console.error("registerUiRoutes returned null"); process.exit(1); }

// ---- 起一个真 HTTP server，把注册的 handler 接上去 ----------------
const server = http.createServer((req, res) => mounted.handler(req, res));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/phone-remote`;

async function call(sub, method = "GET", body) {
  const res = await fetch(base + sub, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

// 1) /state 应带 account
const s1 = await call("/state");
check("state.account 存在", s1.json?.tailscale?.account, JSON.stringify(s1.json?.tailscale?.account));
check("state.account.loggedIn = true", s1.json?.tailscale?.account?.loggedIn === true);
check("state.account.loginName = Airisey@github", s1.json?.tailscale?.account?.loginName === "Airisey@github");
check("state.account.tailnetName = stub-tailnet", s1.json?.tailscale?.account?.tailnetName === "stub-tailnet");
check("state.loggedOut = false（初始）", s1.json?.loggedOut === false);

// 2) 不带 confirm 的 logout 必须被挡住，且不能真的调 tailscale logout
//    （响应末尾会附带一次 state 刷新，那里面本来就有 status / serve status，
//     所以这里只数 "logout" 这条，不能数总调用数。）
const callsPath = path.join(stubDir, "calls.log");
const countLogout = () => readFileSync(callsPath, "utf8").trim().split("\n")
  .filter(Boolean).filter((l) => JSON.parse(l)[0] === "logout").length;
const before = countLogout();
const s2 = await call("/logout", "POST", {});
check("无 confirm 被拒", s2.json?.ok === false && s2.json?.needConfirm === true, s2.json?.message);
  // needConfirm 只是"等你再点一次"，不该污染 lastError（否则面板会一直挂红字）。
  check("needConfirm 不写 lastError", (s2.json?.state?.lastError || "") === "", String(s2.json?.state?.lastError));
check("无 confirm 时不调用 tailscale logout", countLogout() === before, `logout 调用数 ${before} → ${countLogout()}`);

// 3) 带 confirm 的 logout 应真的执行并改状态
const s3 = await call("/logout", "POST", { confirm: true });
check("带 confirm 的 logout ok", s3.json?.ok === true, s3.json?.message);
check("logout 消息里含被退出的账号", /Airisey@github/.test(s3.json?.message || ""), s3.json?.message);
check("afterLogout 被调用一次", cfg.loggedOutCalls === 1, `calls=${cfg.loggedOutCalls}`);
check("afterLogout 后 paused = true", cfg.paused === true);
check("logout 返回 remaining.loggedIn = false", s3.json?.remaining?.loggedIn === false, JSON.stringify(s3.json?.remaining));

// 4) logout 之后的 state 应反映未登录
const s4 = await call("/state");
check("state.loggedOut = true（退出后）", s4.json?.loggedOut === true);
check("state.tailscale.account.loggedIn = false", s4.json?.tailscale?.account?.loggedIn === false);
check("state.tailscale.backendState = NeedsLogin", s4.json?.tailscale?.backendState === "NeedsLogin", s4.json?.tailscale?.backendState);
check("state.paused = true（看门狗已挂起）", s4.json?.paused === true, String(s4.json?.paused));

// 5) 再退出一次：已是未登录，应直接成功且不再 paused 变化
const s5 = await call("/logout", "POST", { confirm: true });
check("重复退出仍 ok（幂等）", s5.json?.ok === true, s5.json?.message);

// 6) /up 应恢复挂起的自动连接
cfg.paused = true;
const s6 = await call("/up", "POST", {});
check("/up 后 paused 被解除", cfg.paused === false);
check("/up 后 state.loggedOut = false", (s6.json?.state?.loggedOut === false), String(s6.json?.state?.loggedOut));

// 7) 未知动作 404
const s7 = await call("/nope", "POST", {});
check("未知动作返回 404", s7.status === 404, String(s7.status));

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}