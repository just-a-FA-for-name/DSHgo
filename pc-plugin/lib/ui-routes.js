// phone-remote UI 后端：给设置页提供状态查询与操作按钮的 HTTP 端点。
//
// 设计：host 半只多注册一条 `/phone-remote/*` 前缀路由，把要做的动作转成
// 对 tailscale.exe 的一次调用。所有动作都是幂等或可重复的，UI 只负责读状态、
// 触发动作，然后重新拉一次状态。
//
// 路由（都挂在同一前缀下）：
//   GET  /phone-remote/state    → { tailscale:{...,account}, bridge:{...}, serve:{...}, loggedOut }
//   POST /phone-remote/up       → tailscale up（必要时重试登录）
//   POST /phone-remote/down     → tailscale down
//   POST /phone-remote/serve    → tailscale serve --bg <port>
//   POST /phone-remote/restart  → 重启 bridge + minter
//   POST /phone-remote/logout   → tailscale logout（作废本机 node key，退回未登录态）
//
// logout 的语义值得写清楚：`tailscale logout` 不只是"断开"，它会让服务端
// 作废掉本机的 node key，之后必须重新授权（浏览器里可以换一个账号登录）。
// 所以它必须带 confirm:true 才会执行，而且执行后插件要停掉 autoUp —— 否则
// 30 秒后的下一轮看门狗又会 `tailscale up`，把用户刚退出的状态顶回去。
//
// 端点不做鉴权：它们只在 dsh 自己的 web 源上暴露，而那个源本来就要登录
// cookie 才能访问（bridge 也只在 loopback 与 tailnet 内可达）。动作本身也
// 只能影响本机 Tailscale，不能读取任意文件或执行任意命令（参数全在闭包里）。

import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TS_CANDIDATES = [
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
];

function pickTs(preferred) {
  if (preferred) {
    if (path.isAbsolute(preferred)) return existsSync(preferred) ? preferred : "tailscale";
    return preferred;
  }
  for (const p of TS_CANDIDATES) if (existsSync(p)) return p;
  return "tailscale";
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        message: err ? String(err.message || "") : "",
      });
    });
  });
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { if (data.length < 65536) data += c; });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

export function registerUiRoutes(ctx, cfg) {
  // webServer 是 dsh 的 host 服务名（见 @deepseek-ai/dsh-host-webserver 的
  // `super(ctx, "webServer")`）。tui / headless 宿主没有它，直接跳过。
  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    return null;
  }

  const tsBin = pickTs(cfg.tailscaleBin);
  const state = {
    lastAction: "",
    lastActionAt: 0,
    lastError: "",
    loginUrl: "",
    // 这条缓存是什么时候拿到的。用它判断"还值不值得给用户看"。
    loginUrlAt: 0,
    loginOffered: false,
    // 刚退出账号：在 state 里回一个标记，让 UI 能解释"为什么连不上"。
    loggedOutAt: 0,
    // tailnet 还没启用 Serve 时的批准链接。这是唯一的人工闸门：命令只会把
    // 链接打到 stdout 上，不接住它就等于把用户丢在一句"需要先批准"里。
    serveApproveUrl: "",
    serveApproveAt: 0,
    // 失败原因分类，UI 据此决定是给批准链接还是给 HTTPS 开关地址。
    serveHint: "",
  };

  async function tsStatus() {
    const r = await run(tsBin, ["status", "--json"], 10000);
    if (!r.ok) return { reachable: false, error: (r.stderr || r.message).trim().split("\n")[0] };
    try {
      return { reachable: true, json: JSON.parse(r.stdout) };
    } catch {
      return { reachable: false, error: "status --json 返回非 JSON" };
    }
  }

  async function serveStatus() {
    const r = await run(tsBin, ["serve", "status", "--json"], 10000);
    if (!r.ok) return { configured: false, error: (r.stderr || r.message).trim().split("\n")[0] };
    let parsed = null;
    try { parsed = JSON.parse(r.stdout || "{}"); } catch {}
    const body = r.stdout || "";
    const configured = new RegExp(`127\\.0\\.0\\.1:${cfg.bridgePort}(?!\\d)`).test(body);
    return { configured, raw: parsed };
  }

  const loginFile = () => path.join(os.homedir(), ".dsh", "logs", "dsh-phone-remote-login.txt");
  const serveFile = () => path.join(os.homedir(), ".dsh", "logs", "dsh-phone-remote-serve.txt");

  // 授权链接是一次性的：点过、或者那次登录已经完成，服务端就把 code 作废了，
  // 之后再打开只会得到 Tailscale 的 "Error 404 / This authentication link
  // could not be located. It may have expired."。
  //
  // 这个文件是 offerLogin() 写的"当时的登录链接"，天然会过期。所以读它必须带
  // 两道闸：太旧的不认（LN_MAX_AGE），机器已经登录并且在跑的直接删掉（见
  // syncLoginFile）。否则退出账号后 AuthURL 为空时，面板会退回这条死链 ——
  // 用户看到的正是那个 404。
  const LN_MAX_AGE_MS = 30 * 60 * 1000;

  function readLoginFile() {
    try {
      const f = loginFile();
      if (!existsSync(f)) return "";
      const age = Date.now() - statSync(f).mtimeMs;
      if (!(age >= 0 && age < LN_MAX_AGE_MS)) return "";
      const t = readFileSync(f, "utf8");
      const m = t.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/);
      return m ? m[0] : "";
    } catch { return ""; }
  }

  /** 这条链接已经没有用了：把自己的缓存和磁盘上的提示文件一起清掉。 */
  function forgetLoginUrl() {
    state.loginUrl = "";
    state.loginUrlAt = 0;
    state.loginOffered = false;
    try { if (existsSync(loginFile())) unlinkSync(loginFile()); } catch {}
  }

  /**
   * 只要机器已经在跑（Running + 有节点密钥），任何"待登录链接"都必然是被消费
   * 过的那一条 —— 留着它只会在下次退出账号时被当成有效链接端给用户。
   */
  function syncLoginFile(j) {
    const up = String(j.BackendState || "") === "Running";
    if (!up) return;
    if (state.loginUrl || existsSync(loginFile())) forgetLoginUrl();
  }

  /**
   * 面板该展示哪条授权链接：优先 Tailscale 自己报的 AuthURL（永远是最新的），
   * 其次才是我们缓存的——而且缓存超过 LN_MAX_AGE_MS 就一律不认。
   */
  function currentLoginUrl(j) {
    const live = String(j.AuthURL || "");
    if (live) return live;
    if (state.loginUrl && Date.now() - (state.loginUrlAt || 0) < LN_MAX_AGE_MS) {
      return state.loginUrl;
    }
    return readLoginFile();
  }

  /**
   * 看门狗（index.js 的 publishServe）也会遇到同一个批准闸门，它把链接写进
   * dsh-phone-remote-serve.txt。面板要能拿到它 —— 否则用户只在日志文件里
   * 才找得到这条链接。没有时效限制：Serve 的批准链接不像登录 code 那样
   * 一次性，节点没变就一直能用。
   */
  function readServeFile() {
    try {
      const f = serveFile();
      if (!existsSync(f)) return "";
      const t = readFileSync(f, "utf8");
      const m = t.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9]+/);
      return m ? m[0] : "";
    } catch { return ""; }
  }

  function readStatusSnapshot() {
    try {
      const f = path.join(os.homedir(), ".dsh", "logs", "dsh-phone-remote-status.json");
      if (!existsSync(f)) return null;
      return JSON.parse(readFileSync(f, "utf8"));
    } catch { return null; }
  }

  /**
   * 从 status --json 里抠出"当前登的是哪个账号"。
   *
   * 字段来源（tailscale 1.x）：
   *   User               { "<UserID>": { LoginName, DisplayName, ProfilePicURL } }
   *   Self.UserID        本机节点所属用户
   *   CurrentTailnet     { Name, MagicDNSSuffix, MagicDNSEnabled }
   *
   * 退出登录后这些字段会变空 / User 变成 {}，所以"有没有账号"本身就是
   * 一个可观测量，不需要自己记状态。
   */
  function describeAccount(j) {
    const selfUser = String((j.Self && j.Self.UserID) || "");
    const users = (j && j.User) || {};
    const me = (selfUser && users[selfUser]) || users[Object.keys(users)[0]] || null;
    const tailnet = j.CurrentTailnet || {};
    return {
      userID: selfUser,
      loginName: me ? String(me.LoginName || "") : "",
      displayName: me ? String(me.DisplayName || "") : "",
      avatarUrl: me ? String(me.ProfilePicURL || "") : "",
      tailnetName: String(tailnet.Name || ""),
      tailnetSuffix: String(tailnet.MagicDNSSuffix || ""),
      loggedIn: !!me && !!selfUser,
    };
  }

  // ---- GET /phone-remote/state ----------------------------------------

  async function handleState() {
    const st = await tsStatus();
    const sv = await serveStatus();
    const j = (st.reachable && st.json) || {};
    const snap = readStatusSnapshot();
    syncLoginFile(j);
    const account = describeAccount(j);

    return {
      ok: true,
      tailscale: {
        reachable: !!st.reachable,
        error: st.reachable ? "" : (st.error || ""),
        backendState: String(j.BackendState || ""),
        haveNodeKey: !!j.HaveNodeKey,
        authUrl: currentLoginUrl(j),
        dnsName: (j.Self && String(j.Self.DNSName || "").replace(/\.$/, "")) || "",
        ips: Array.isArray(j.TailscaleIPs) ? j.TailscaleIPs : [],
        hostname: (j.Self && String(j.Self.HostName || "")) || "",
        account,
        peers: Object.values(j.Peer || {}).map((p) => ({
          name: String(p.HostName || ""),
          dns: String(p.DNSName || "").replace(/\.$/, ""),
          os: String(p.OS || ""),
          online: !!p.Online,
          ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [],
        })),
      },
      serve: (() => {
        // 已经发布成功的话，批准链接就没有意义了（node key 没变时它一直是同一条，
        // 留着只会让人以为还有事没做）。
        if (sv.configured) {
          state.serveApproveUrl = "";
          state.serveApproveAt = 0;
          state.serveHint = "";
          return { configured: true, port: cfg.bridgePort, error: "", approveUrl: "", hint: "" };
        }
        const approveUrl = state.serveApproveUrl || readServeFile();
        return {
          configured: false,
          port: cfg.bridgePort,
          error: sv.error || "",
          approveUrl,
          // 有批准链接就一定是 serve 未启用；否则给出 HTTPS 开关的提示。
          hint: state.serveHint || (approveUrl ? "approve" : ""),
        };
      })(),
      // 可视化设置项的当前值（来自运行中的实例配置）
      settings: {
        bridgePort: cfg.bridgePort,
        cliPort: cfg.cliPort,
        serve: cfg.serve !== false,
        autoTailscale: cfg.autoTailscale !== false,
        stopOnExit: cfg.stopOnExit === true,
      },
      bridge: {
        port: cfg.bridgePort,
        cliPort: cfg.cliPort,
        alive: !!(snap && snap.bridgeAlive),
        minterAlive: !!(snap && snap.minterAlive),
        // 登录签发（minter）起不来时的最后一条失败原因。手机端停在等待页时，
        // 用户看到的第一个症状就是「登录签发端口 · 未运行」，把它连同原因一起
        // 摆出来才解释得清"为什么手机打不开"。
        minterError: String((snap && snap.minterError) || ""),
        minterProfile: String((snap && snap.minterProfile) || ""),
      },
      loggedOut: state.loggedOutAt > 0,
      loggedOutAt: state.loggedOutAt,
      // 看门狗是否已被退出账号这件事挂起。UI 用它区分"没登录"和"没登录且不会被自动拉起"。
      paused: (() => { try { return typeof cfg.getPaused === "function" ? !!cfg.getPaused() : false; } catch { return false; } })(),
      lastAction: state.lastAction,
      lastActionAt: state.lastActionAt,
      lastError: state.lastError,
    };
  }

  // ---- POST 动作 -------------------------------------------------------

  async function doUp() {
    // 用户显式点「连接」= 表达"我确实想连"，把退出账号时挂起的自动连接恢复回来。
    // 恢复要走插件实例的 resumeTunnel()：它在闭包里，能同时清掉 serveDone /
    // serveRetryAt，否则重新登录后 serve 会被误判成"已经发布过"而不再发。
    state.loggedOutAt = 0;
    try { if (typeof cfg.resumeTunnel === "function") cfg.resumeTunnel(); } catch {}
    try { if (typeof cfg.setPaused === "function") cfg.setPaused(false); } catch {}
    // 先 --unattended：Windows 版在最后一个客户端断开时会主动停隧道，
    // 无人值守模式让它在 dsh 关闭后仍保持在线。
    await run(tsBin, ["set", "--unattended=true"], 15000);
    const before = await tsStatus();
    const backend = before.reachable ? String((before.json || {}).BackendState || "") : "";
    if (backend === "Running") return { ok: true, message: "已经连接" };

    const r = await run(tsBin, ["up", "--timeout", "20s", "--unattended"], 40000);
    const text = `${r.stdout}\n${r.stderr}`;
    const m = text.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/);
    if (m) {
      state.loginUrl = m[0];
      state.loginUrlAt = Date.now();
      return { ok: false, needLogin: true, loginUrl: m[0], message: "需要在浏览器里授权一次" };
    }
    if (!r.ok) {
      const first = (r.stderr || r.message || "").trim().split("\n")[0];
      return { ok: false, message: first || "tailscale up 失败" };
    }
    const after = await tsStatus();
    const b2 = after.reachable ? String((after.json || {}).BackendState || "") : "";
    return { ok: b2 === "Running", message: b2 === "Running" ? "已连接" : `状态：${b2 || "未知"}` };
  }

  async function doDown() {
    const r = await run(tsBin, ["down"], 20000);
    return { ok: r.ok, message: r.ok ? "已断开" : ((r.stderr || r.message).trim().split("\n")[0] || "断开失败") };
  }

  // ---- 退出账号 -------------------------------------------------------
  //
  // `tailscale logout` 与 `tailscale down` 的区别是本质的：
  //   · down   只关隧道，凭据还在，下次 up 直接连回来（毫秒级）；
  //   · logout 会向控制面作废本机 node key，凭据彻底失效，下次 up 必须在
  //            浏览器里重新授权 —— 那一步也正好是切换账号的入口。
  //
  // 所以这里有三个约束：
  //   1. 必须 confirm:true（UI 做二次确认，路由本身也拦一道，避免误触）；
  //   2. 退出后要让插件实例挂起整条自动连接链路（tsPaused），否则 30 秒后
  //      看门狗又会 up —— 配了 authKey 时甚至会直接用同一把密钥登回去；
  //   3. 挂起必须在**确认退出成功之后**才发生 —— 退出失败时用户的自动连接
  //      能力不能被顺手没收掉。
  //
  // 挂起用 `afterLogout()` 做（插件实例的闭包里），这里不自己维护 second
  // source of truth。失败路径压根不碰挂起状态，也就没有需要回滚的东西。

  async function doLogout(body) {
    let payload = {};
    try { payload = JSON.parse(body || "{}"); } catch {}
    if (payload.confirm !== true) {
      return { ok: false, needConfirm: true, message: "退出账号会作废本机授权，需要再点一次确认" };
    }

    const before = await tsStatus();
    const j0 = before.reachable ? (before.json || {}) : {};
    const was = describeAccount(j0);
    // 没登录时 logout 在部分版本里会报 "not logged in"，直接当成功处理。
    const backend = String(j0.BackendState || "");
    if (before.reachable && !was.loggedIn && backend !== "Running") {
      state.loggedOutAt = Date.now();
      // 退出前先把旧链接清干净：logout 之后 AuthURL 会变空，这时若还留着上一次
      // 登录用过的 code，面板就会把那条死链再端给用户 —— 打开只得到 404。
      forgetLoginUrl();
      // 已经是未登录态也照样挂起：否则看门狗下一轮就会 up，把用户刚退出的
      // 状态顶回去 —— 这一条与"真的执行了 logout"路径必须一致。
      if (typeof cfg.afterLogout === "function") {
        try { await cfg.afterLogout(); } catch {}
      } else {
        try { if (typeof cfg.setPaused === "function") cfg.setPaused(true); } catch {}
      }
      return { ok: true, message: "当前已经是未登录状态", account: was };
    }

    try {
      const r = await run(tsBin, ["logout"], 30000);
      const text = `${r.stdout}\n${r.stderr}`.trim();
      if (!r.ok && !/not logged in|already logged out|no node key/i.test(text)) {
        const first = (r.stderr || r.message || "").trim().split("\n")[0];
        return { ok: false, message: first || "tailscale logout 失败（自动连接未受影响）", account: was };
      }
    } catch (e) {
      return { ok: false, message: `退出失败：${(e && e.message) || e}` };
    }

    // 复核：node key 应已作废（HaveNodeKey=false 或 BackendState=NeedsLogin）。
    const after = await tsStatus();
    const j1 = after.reachable ? (after.json || {}) : {};
    const stillIn = !!j1.HaveNodeKey && String(j1.BackendState || "") === "Running";

    state.loggedOutAt = Date.now();
    // 同理：刚作废的 node key 对应的授权链接已经没用了，别留在缓存里。
    forgetLoginUrl();
    if (typeof cfg.afterLogout === "function") {
      try { await cfg.afterLogout(); } catch {}
    }

    return {
      ok: !stillIn,
      message: stillIn
        ? "已执行 logout，但隧道仍在运行；请手动执行 tailscale logout 检查"
        : `已退出${was.loginName ? " " + was.loginName : ""}，本机授权已作废`,
      account: was,
      remaining: describeAccount(j1),
    };
  }

  async function doServe() {
    const r = await run(tsBin, ["serve", "--bg", String(cfg.bridgePort)], 25000);
    const text = `${r.stdout}\n${r.stderr}`;
    const approve = text.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9]+/);
    if (approve) {
      // 批准链接是唯一的可执行动作，必须留在 state 里 —— 面板每 5 秒拉一次
      // state，靠它就能把链接渲染出来，不用用户去翻日志文件。
      state.serveApproveUrl = approve[0];
      state.serveApproveAt = Date.now();
      state.serveHint = "approve";
      return { ok: false, needApprove: true, approveUrl: approve[0], message: "tailnet 需要先批准 Serve" };
    }
    // 换过 tailnet 之后 CertDomains 会是空的：serve 要 443 上的证书，没有就
    // 一直失败。这个和"没批准"是两回事，给的入口也不一样，得分开说。
    if (/does not support getting TLS certs|HTTPS.*(disabled|not enabled)|enable HTTPS/i.test(text)) {
      state.serveHint = "https";
      state.serveApproveUrl = "";
      state.serveApproveAt = 0;
      return {
        ok: false, needHttps: true,
        message: "tailnet 还没开启 HTTPS 证书（serve 需要它才能用 443）",
      };
    }
    if (!r.ok) {
      const first = (r.stderr || r.message || "").trim().split("\n")[0];
      const firstOut = (r.stdout || "").trim().split("\n")[0];
      state.serveHint = "";
      return { ok: false, message: first || firstOut || "serve 发布失败" };
    }
    // 命令会挂着等批准，所以超时也算"已发出"
    const sv = await serveStatus();
    if (sv.configured) {
      state.serveHint = "";
      state.serveApproveUrl = "";
      state.serveApproveAt = 0;
      return { ok: true, message: "已发布到 tailnet" };
    }
    return { ok: false, message: "已提交，但 serve 配置还没生效；稍后再点一次「发布」" };
  }

  async function doRestart() {
    if (cfg.restart) return await cfg.restart();
    return { ok: false, message: "当前插件实例不支持重启子进程" };
  }

  /**
   * 保存可视化设置。只改 profile 的 cordis.patch.yml 里 phone-remote 那一段，
   * 其余内容原样保留；端口类改动需要重启 DSH 才生效（bridge 已经在跑了）。
   */
  async function doConfig(body) {
    if (!cfg.saveConfig) return { ok: false, message: "当前插件实例不支持保存配置" };
    let patch;
    try { patch = JSON.parse(body || "{}"); } catch { return { ok: false, message: "请求体不是合法 JSON" }; }

    const allowed = ["bridgePort", "cliPort", "serve", "autoTailscale", "stopOnExit"];
    const clean = {};
    for (const k of allowed) {
      if (!(k in patch)) continue;
      if (k === "bridgePort" || k === "cliPort") {
        const n = Number(patch[k]);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
          return { ok: false, message: `${k} 必须是 1024–65535 的整数` };
        }
        clean[k] = n;
      } else {
        clean[k] = !!patch[k];
      }
    }
    if (Object.keys(clean).length === 0) return { ok: false, message: "没有可保存的字段" };

    const r = cfg.saveConfig(clean);
    if (r && r.ok) {
      // 立刻热生效：不然保存完 state 还报旧值，开关会自己弹回去。
      // applyRuntime 改的是插件实例里真正被使用的那份 cfg。
      try { if (typeof cfg.applyRuntime === "function") cfg.applyRuntime(clean); } catch {}
      for (const k of allowed) if (k in clean) cfg[k] = clean[k];
    }
    return r;
  }

  // ---- 路由分发 -------------------------------------------------------

  const handler = async (req, res) => {
    const url = String(req.url || "");
    const pathname = url.split("?")[0];
    const sub = pathname.slice("/phone-remote".length) || "/";
    const method = String(req.method || "GET").toUpperCase();
    state.lastActionAt = Date.now();
    try {
      if (sub === "/state" && (method === "GET" || method === "HEAD")) {
        return json(res, 200, await handleState());
      }
      const body = await readBody(req);
      let out;
      if (sub === "/up") out = await doUp();
      else if (sub === "/down") out = await doDown();
      else if (sub === "/serve") out = await doServe();
      else if (sub === "/restart") out = await doRestart();
      else if (sub === "/logout") out = await doLogout(body);
      else if (sub === "/config") out = await doConfig(body);
      else return json(res, 404, { ok: false, message: "未知动作" });

      state.lastAction = sub.slice(1);
      // needConfirm / needApprove / needHttps 都是「还有一步由你来点」的提示，
      // 不是失败。写进 lastError 会让面板一直顶着一条「上次操作失败」的红字，
      // 而真正该看的批准链接在 serve.approveUrl 里。
      const soft = out.needConfirm || out.needApprove || out.needHttps;
      if (!out.ok && !soft) state.lastError = out.message || "";
      else state.lastError = "";
      return json(res, 200, { ...out, state: await handleState() });
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      return json(res, 500, { ok: false, message: state.lastError });
    }
  };

  const dispose = webServer.register({
    kind: "prefix",          // 该字段名是 kind，值域 "exact" | "prefix"
    path: "/phone-remote",
    handler,
  });
  return { dispose, state };
}
