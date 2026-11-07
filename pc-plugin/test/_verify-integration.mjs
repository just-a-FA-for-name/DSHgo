// 集成验证：真正加载 lib/index.js 的 apply()，用假的 ctx（含 webServer）把它挂起来，
// 然后打 /phone-remote/state，确认 index.js → ui-routes.js 这条接线是真的通。
//
// 安全约束（重要）：
//   · 只调用只读的 /state，绝不调用 /logout —— 那会真的把这台机器退出 Tailscale。
//   · minter:false + serve:false + bridgePort 指向一个已被占用的端口，
//     所以看门狗不会真的拉起 bridge/minter，也不会有任何监听。
//   · 跑完把 dsh-phone-remote-status.json 还原（watch 会重写它）。
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const statusFile = path.join(os.homedir(), ".dsh", "logs", "dsh-phone-remote-status.json");
const statusBak = statusFile + ".verify-bak";
if (existsSync(statusFile)) copyFileSync(statusFile, statusBak);

const mod = await import("file:///" + path.join(here, "lib", "index.js").replace(/\\/g, "/"));

const logs = [];
const logger = {
  info: (m) => logs.push("INFO " + m),
  warn: (m) => logs.push("WARN " + m),
  error: (m) => logs.push("ERR " + m),
};

let handler = null;
const webServer = {
  register(opts) {
    check_mount(opts);
    handler = opts.handler;
    return () => { handler = null; };
  },
};
let mountedPath = "";
function check_mount(opts) { mountedPath = String(opts.path || ""); }

const ctx = {
  logger: () => logger,
  effect(fn) { try { fn(); } catch (e) { logs.push("EFFECT-ERR " + e.message); } },
  inject(services, cb) {
    // 只有一个注入点：webServer。真实宿主传进来的是一个"带 webServer 服务的
    // 子 ctx"，registerUiRoutes 内部读的是 ctx.webServer.register —— 所以这里
    // 必须包一层 { webServer }，不能直接把 webServer 当 ctx 传。
    cb({ webServer });
  },
};

// 先把一个端口占住，再把它当成 bridgePort —— 这样 portBusy() 必然为 true，
// 看门狗就不会真的去 spawn bridge。（不能写死某个"看起来被占"的端口：
// DSH 自己的端口会变，一旦空出来这段测试就会真的拉起子进程。）
const net = await import("node:net");
const blocker = net.createServer();
await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
const blockedPort = blocker.address().port;

const cfg = {
  bridgePort: blockedPort,
  cliPort: blockedPort,
  minter: false,
  serve: false,
  tailscale: { enabled: true, autoUp: true, autoLogin: false },
};

async function isPortBusy(port) {
  const net = await import("node:net");
  return await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

mod.apply(ctx, cfg);
await new Promise((r) => setTimeout(r, 4000)); // 让首轮 watch() 跑完

check("apply() 未抛异常", true);
check("注册了 /phone-remote 前缀路由", mountedPath === "/phone-remote", mountedPath);
check("拿到了路由 handler", typeof handler === "function");

if (typeof handler === "function") {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/phone-remote`;

  const call = async (sub, method = "GET", body) => {
    const res = await fetch(base + sub, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: res.status, json: j };
  };

  const s1 = await call("/state");
  const ts = s1.json?.tailscale || {};
  check("/state 返回 200", s1.status === 200, String(s1.status));
  check("/state 带 tailscale.account（index→routes 接线通）", !!ts.account, JSON.stringify(ts.account));
  check("/state 带 loggedOut 字段", s1.json?.loggedOut === false, String(s1.json?.loggedOut));
  check("/state 带 paused 字段（来自 index 的 getPaused）", s1.json?.paused === false, String(s1.json?.paused));
  check("account 结构完整（read-only 读取）",
    !!ts.account && typeof ts.account === "object" && "loggedIn" in ts.account,
    ts.account?.loginName || "(当前未登录，字段仍应在)");
  // 注意：bridge.alive 来自 ~/.dsh/logs/dsh-phone-remote-status.json，而那个文件是
  // **所有实例共享**的 —— 真正在跑的 GUI 每轮 watch() 都会覆盖它。所以这里只能断言
  // 端口是按我们的配置报的，不能断言 alive=false（那取决于别人刚写了什么）。
  check("bridge 端口取自本次 cfg", s1.json?.bridge?.port === blockedPort, String(s1.json?.bridge?.port));
  check("本次实例没有监听自己的 bridge 端口（已由测试自己占住）",
    (await isPortBusy(blockedPort)) === true, blockedPort + " busy");

  // 不带 confirm 的 logout 必须被挡住（这里也顺带确认它不会真退出）
  const before = s1.json?.tailscale?.account?.loggedIn === true;
  const s2 = await call("/logout", "POST", {});
  check("不带 confirm 的 logout 被拒", s2.json?.ok === false && s2.json?.needConfirm === true, s2.json?.message);
  check("拒绝后账号状态未变（没被误退出）",
    (s2.json?.state?.tailscale?.account?.loggedIn === true) === before,
    String(s2.json?.state?.tailscale?.account?.loginName));

  const s3 = await call("/nope", "POST", {});
  check("未知动作 404", s3.status === 404, String(s3.status));

  server.close();
}

// ---- 源码契约：看门狗真的被 tsPaused 挡住 ------------------------------
const src = readFileSync(path.join(here, "lib", "index.js"), "utf8");
check("watch() 受 tsPaused 约束", /if \(cfg\.autoTailscale && !tsPaused\)/.test(src));
check("tsReady 也考虑 tsPaused", /ts\.state === "running" && !tsPaused/.test(src));
check("uiCfg 暴露 afterLogout", /afterLogout:\s*async/.test(src));
check("afterLogout 里设置 tsPaused = true", /afterLogout:[\s\S]{0,400}tsPaused = true/.test(src));
check("uiCfg 暴露 getPaused", /getPaused:\s*\(\)\s*=>\s*tsPaused/.test(src));
check("uiCfg 暴露 setPaused", /setPaused:\s*\(v\)\s*=>/.test(src));
check("uiCfg 暴露 resumeTunnel", /resumeTunnel:\s*\(\)\s*=>/.test(src));
check("退出账号时收掉 bridge/minter", /afterLogout:[\s\S]{0,400}killChild\("bridge"\)/.test(src));

// ---- 还原状态快照 -----------------------------------------------------
if (existsSync(statusBak)) { copyFileSync(statusBak, statusFile); unlinkSync(statusBak); }
try { blocker.close(); } catch {}
console.log("\n--- plugin log ---");
console.log(logs.join("\n"));

const failed = results.filter((f) => !f.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(", "));

// 插件实例自己会留一个 30s 的看门狗定时器（apply() 里设的），不显式退出的话
// 进程会一直挂着不返回。测试只需要结论，所以直接把事件循环掐掉。
process.exit(failed.length ? 1 : 0);