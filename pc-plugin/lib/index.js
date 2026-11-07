// dsh-phone-remote — DSHgo 手机远程，PC 端，作为 dsh 插件运行。
//
// 原版只负责 minter / bridge / tailscale serve 三件事，前提是"Tailscale 已经在跑
// 并且已登录"。本增强版把 Tailscale 本身也纳入守护范围，做到：只开 dsh，
// Tailscale 隧道自动就绪。
//
//   tailscaled    服务没起就尝试拉起（安装器默认是 Auto，这里兜底）
//   tailscale up  未连接时自动连接（WantRunning=false / Stopped 时自动拉起）
//   login         首次需要登录时，把登录链接写进日志文件并打印出来
//   serve         `tailscale serve --bg <bridgePort>`，幂等，配置丢了自动补
//   minter        `dsh web` 子进程，签发登录 cookie
//   bridge        node bridge/dsh-phone-proxy.cjs，手机流量入口
//
// 设计原则不变：不碰任何 dsh 内部接口，只用 apply(ctx, config) + node 内置模块，
// 只监督外部进程，所以 dsh 升级不影响本插件。
//
// 配置（都可选，写在 cordis.patch.yml 的 phone-remote 条目 config 里）：
//   bridgePort     8124     手机流量入口
//   cliPort        8090     cookie 签发的 dsh web 实例
//   minter         true     自己已跑 dsh web 时可关
//   trustedHost    ""       透传给 dsh web --trusted-host
//   serve          true     自己管理 tailscale serve 时可关
//   dshBin         ""       留空自动探测（桌面版 runtime\cli\bin\dsh.cmd）
//   tailscaleBin   ""       留空自动探测（Program Files\Tailscale\tailscale.exe）
//   tailscale:
//     enabled          true   是否接管 Tailscale 启停；false = 完全手动
//     autoUp           true   未连接时是否自动 `tailscale up`
//     autoLogin        true   需要登录时是否写出登录链接
//     openLoginBrowser false  是否顺手打开浏览器登录页
//     serveRetryMs     60000  serve 失败后的重试间隔
//     upTimeoutMs      25000  tailscale up 的超时
//
// 环境变量覆盖（测试用，优先级最高）：
//   DSH_PHONE_BRIDGE_PORT / DSH_PHONE_CLI_PORT / DSH_PHONE_NO_SERVE
//   DSH_PHONE_NO_TAILSCALE  置 1 则完全不碰 Tailscale（只跑 bridge/minter）
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSync, closeSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { registerUiRoutes } from "./ui-routes.js";

export const name = "phone-remote";

// ── 设置命名空间的“入场券” ────────────────────────────────────────────────
//
// dsh 的 settings 服务用 `configEditor.entries().find(e => e.options.id === ns)`
// 定位命名空间，再取该 entry 的 `fiber.runtime.Config`（本模块导出的 `Config`），
// 然后 `volatileForm(schema)` 只保留带 volatile 标记的字段。任一条不满足，
// 这个命名空间就不会出现在 `settings.describe` 里：
//   - 没有 Config 导出            → schema undefined → 整条被跳过
//   - Config 里没有 volatile 字段 → volatileForm 返回 undefined → 整条被跳过
//
// 更关键的是 cordis 装配插件时会执行
//     runtime.Config["~standard"].validate(config)
// 所以 Config 必须是**真的 schemastery schema**，自造替身会因为没有
// "~standard" 而让整个 entry 装配失败 —— 表现就是这个插件彻底不运行。
//
// 插件目录下没有 node_modules，裸 import 解析不到 schemastery；但 profile 里
// 通常已经装了一份（别的插件依赖它）。这里按绝对路径用 createRequire 去找。
import { createRequire } from "node:module";

function loadSchemastery() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const roots = [];
  try {
    const profDir = path.join(home, "profiles");
    if (existsSync(profDir)) {
      for (const n of readdirSync(profDir)) roots.push(path.join(profDir, n));
    }
  } catch {}
  roots.push(path.join(os.homedir(), ".dsh", "profiles", "desktop"));
  roots.push(process.cwd());

  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "package.json"));
      return req(req.resolve("@deepseek-ai/schemastery"));
    } catch {}
  }
  return null;
}

const z = (() => {
  const m = loadSchemastery();
  return m ? (m.default || m) : null;
})();

function volatileField(defaultValue, description) {
  const base = typeof defaultValue === "boolean" ? z.boolean() : z.number();
  return base.default(defaultValue).description(description).extra("volatile", true);
}

// 拿不到 schemastery 就不导出 Config：宁可没有设置页，也不能让插件装配失败。
export const Config = z
  ? z.object({
      bridgePort: volatileField(8124, "手机流量入口端口（bridge 监听）"),
      cliPort: volatileField(8090, "用于签发登录 cookie 的 dsh web 实例端口"),
      serve: volatileField(true, "隧道就绪后自动把 bridge 端口发布到 tailnet"),
      autoTailscale: volatileField(true, "接管 Tailscale：未连接时自动拉起"),
      // 默认 false：DSH 关掉时不要把隧道拆了。
      // 手机端（DSHgo APK）用的是它自己内置的 libtailscale 引擎，那个引擎没有
      // 任何保活/重连定时器；PC 一旦 `tailscale down` + `sc stop Tailscale`，
      // 手机侧引擎就掉线，而且 TailscaleVpnService 不会自己拉回来、
      // MainActivity.poll() 在 App 退到后台（!resumed）时直接 return。
      // 结果就是人必须拿起手机重开一次 App 才能恢复——所以默认不拆。
      stopOnExit: volatileField(false, "DSH 退出时断开 Tailscale 隧道（关掉可让手机随时可连）"),
    })
  : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function logDir() {
  const dir = path.join(homeDir(), ".dsh", "logs");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

const logFile = (file) => path.join(logDir(), file);

// ── minter 专用的 profile ─────────────────────────────────────────────────
//
// minter 曾经复用用户自己的 `web` profile（`dsh web`），结果被外部改坏：
// profile 的 cordis.patch.yml 里被写进了 `disabled: true`（system-prompt、
// tools 的提供者等），于是 `dsh web` 每次启动都死在
//
//     dsh: startup failed: 2 required plugins did not activate
//
// minter 一起不来就没有 launch token；bridge 拿不到 token 就 `mintCookie()`
// 失败、`scanAppPort()` 直接放弃 → appPort 停在 fallback 4505 → 手机永远停在
// 「正在等待电脑上的 DSH 桌面 App…」。
//
// 所以 minter 用插件自己的 profile，内容等于出厂 web 模板（base + web-app，
// 空 patch 层），没有任何人/任何插件会去改它。它仍然跑在**同一个 DSH_HOME**
// 下 —— 这点不能妥协：cookie 的签名域跟着 DSH_HOME 走，实测隔离 HOME 起的
// 实例签的 cookie 打桌面 App 是 401，同 HOME 的则是 200。
const MINTER_PROFILE = "dsh-phone-minter";
const MINTER_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/** DSH_HOME（`~/.dsh`）。cookie 的签名域跟着它走，minter 必须与宿主同域。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(homeDir(), ".dsh");
}

/**
 * 保证 minter profile 存在且是"干净"的。
 *
 * 只在文件缺失时才写，不覆盖已有的：用户可能自己加了 `--trusted-host` 之类
 * 的 patch，抢过来重写会踩掉他的东西。但 package.json 的 bundles 必须核对，
 * 因为它是"这个 profile 能不能起来"的唯一决定因素 —— 被塞进任何第三方
 * bundle 都可能像 web profile 那样把必需插件禁掉。
 *
 * @returns {{ok: boolean, dir: string, message: string, changed: boolean}}
 */
function ensureMinterProfile() {
  const dir = path.join(dshHome(), "profiles", MINTER_PROFILE);
  const changed = [];
  try {
    mkdirSync(dir, { recursive: true });

    const pkgFile = path.join(dir, "package.json");
    const wantPkg = {
      name: `dsh-profile-${MINTER_PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: MINTER_BUNDLES } },
    };
    let needPkg = true;
    if (existsSync(pkgFile)) {
      try {
        const cur = JSON.parse(readFileSync(pkgFile, "utf8"));
        const curBundles = (cur && cur.dsh && cur.dsh.profile && cur.dsh.profile.bundles) || [];
        needPkg = JSON.stringify(curBundles) !== JSON.stringify(MINTER_BUNDLES);
      } catch { needPkg = true; }
    }
    if (needPkg) {
      writeFileSync(pkgFile, JSON.stringify(wantPkg, null, 2) + "\n", "utf8");
      changed.push("package.json");
    }

    // 空 patch 层 + 空根层：模板里是注释加 `[]`，这里保持同形状，免得
    // 某个版本的 loader 对"空文件"和"空数组"的理解不一致。
    const patchFile = path.join(dir, "cordis.patch.yml");
    if (!existsSync(patchFile)) {
      writeFileSync(patchFile, [
        "# dsh-phone-remote 的 cookie 签发实例（minter）专用 profile。",
        "# 这里刻意留空：minter 只需要 base + web-app，越干净越不容易被改坏。",
        "[]",
        "",
      ].join("\n"), "utf8");
      changed.push("cordis.patch.yml");
    }

    const rootFile = path.join(dir, "cordis.yml");
    if (!existsSync(rootFile)) {
      writeFileSync(rootFile, [
        "# dsh profile root — 空条目列表，实际组合来自 package.json 的 bundles。",
        "[]",
        "",
      ].join("\n"), "utf8");
      changed.push("cordis.yml");
    }

    const wsFile = path.join(dir, "pnpm-workspace.yaml");
    if (!existsSync(wsFile)) {
      writeFileSync(wsFile, "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
      changed.push("pnpm-workspace.yaml");
    }

    return { ok: true, dir, changed: changed.length > 0, files: changed, message: "" };
  } catch (e) {
    return { ok: false, dir, changed: false, files: changed, message: String((e && e.message) || e) };
  }
}

/** tailscale.exe 常见位置（安装器默认路径）。 */
const TS_CANDIDATES = [
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
];

/** dsh.cmd 常见位置：桌面版安装目录下的 runtime\cli\bin。 */
function dshCandidates() {
  const out = [];
  // 1) 正常情况：process.execPath 就是桌面版主程序 "…\DeepSeek Harness.exe"
  try {
    const exeDir = path.dirname(process.execPath);
    out.push(path.join(exeDir, "resources", "runtime", "cli", "bin", "dsh.cmd"));
  } catch {}
  // 2) 桌面版默认安装位置（独立测试 / 非 Electron 宿主时兜底）
  const local = process.env.LOCALAPPDATA;
  if (local) out.push(path.join(local, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"));
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (base) out.push(path.join(base, "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"));
  }
  // 3) 宿主自己给的 node 启动器目录（桌面版会把 dsh 的 bin 放进 PATH 前端）
  const binDir = process.env.DSH_DESKTOP_NODE_EXECUTABLE && path.dirname(process.env.DSH_DESKTOP_NODE_EXECUTABLE);
  if (binDir) out.push(path.join(binDir, "..", "..", "cli", "bin", "dsh.cmd"));
  return out;
}

function pickBin(preferred, candidates, fallback) {
  const list = [];
  if (preferred) list.push(preferred);
  list.push(...candidates);
  for (const p of list) {
    if (!p) continue;
    if (path.isAbsolute(p)) { if (existsSync(p)) return p; }
    else return p; // 裸名交给 PATH
  }
  return fallback;
}

/** Windows 命令行参数转义（给 cmd.exe /c 用）。 */
function winQuote(s) {
  if (!/[ \t"&|<>^()]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 跑 .cmd / .bat。Node 不能在不经 shell 的情况下执行 .cmd，而 shell:true 又不会
 * 给带空格的可执行路径加引号（"Program Files" 会被截断），所以自己拼命令行。
 *
 * 关键点：`cmd /c "..."` 必须靠 windowsVerbatimArguments 原样传参，否则 Node 会
 * 再做一次引号转义，把 /s 语义破坏掉，路径在空格处被切断。
 */
function spawnCmd(exe, args, options) {
  const line = [exe, ...args].map(winQuote).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

/**
 * 把设置写回当前 profile 的 cordis.patch.yml。
 *
 * 只改 `id: phone-remote` 那一条的 config，文件其余内容（别的插件的块、注释、
 * 顺序）原样保留 —— 这点很关键，之前 dsh-remote-access 的 deploy 脚本整体
 * 重写文件，把别人的配置吃掉过。
 *
 * @param {Record<string, unknown>} values 已校验的字段（bridgePort/cliPort/serve/autoTailscale）
 * @returns {{ok: boolean, message: string}}
 */
function savePatchConfig(values) {
  const profile = process.env.DSH_PROFILE || "desktop";
  const file = path.join(homeDir(), ".dsh", "profiles", profile, "cordis.patch.yml");
  if (!existsSync(file)) return { ok: false, message: `找不到 ${file}` };

  const raw = readFileSync(file, "utf8");
  const wasCRLF = /\r\n/.test(raw);
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const idIdx = lines.findIndex((l) => /^\s*-\s*id:\s*['"]?phone-remote['"]?\s*$/.test(l));
  if (idIdx < 0) {
    return { ok: false, message: "patch 里没有 phone-remote 条目，先运行 install-patch.mjs" };
  }

  const itemIndent = lines[idIdx].match(/^\s*/)[0].length;
  const propIndent = " ".repeat(itemIndent + 2);
  const cfgIndent = propIndent + "  ";

  let endIdx = lines.length;
  for (let i = idIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= itemIndent && /^\s*-/.test(l)) { endIdx = i; break; }
    if (ind === 0 && !/^\s*-/.test(l) && !l.trimStart().startsWith("#")) { endIdx = i; break; }
  }

  const block = lines.slice(idIdx, endIdx);
  const cfgRel = block.findIndex((l) => new RegExp(`^${propIndent}config:\\s*$`).test(l));

  // 已有的 config 正文
  let body = [];
  if (cfgRel >= 0) {
    for (const l of block.slice(cfgRel + 1)) {
      if (l.trim() === "") { body.push(l); continue; }
      if (l.match(/^\s*/)[0].length <= propIndent.length) break;
      body.push(l);
    }
  }

  const upsert = (key, val, indent) => {
    const re = new RegExp(`^${indent}${key}:`);
    const i = body.findIndex((l) => re.test(l));
    const line = `${indent}${key}: ${val}`;
    if (i >= 0) body[i] = line;
    else body.push(line);
  };

  if (values.bridgePort !== undefined) upsert("bridgePort", values.bridgePort, cfgIndent);
  if (values.cliPort !== undefined) upsert("cliPort", values.cliPort, cfgIndent);
  if (values.serve !== undefined) upsert("serve", values.serve, cfgIndent);
  if (values.stopOnExit !== undefined) upsert("stopOnExit", values.stopOnExit, cfgIndent);

  if (values.autoTailscale !== undefined) {
    const childIndent = cfgIndent + "  ";
    const tsRe = new RegExp(`^${cfgIndent}tailscale:\\s*$`);
    let tsIdx = body.findIndex((l) => tsRe.test(l));
    if (tsIdx < 0) {
      body.push(`${cfgIndent}tailscale:`);
      body.push(`${childIndent}enabled: true`);
      body.push(`${childIndent}autoUp: true`);
      body.push(`${childIndent}autoLogin: true`);
      body.push(`${childIndent}autoTailscale: ${values.autoTailscale}`);
    } else {
      let e = body.length;
      for (let i = tsIdx + 1; i < body.length; i++) {
        if (body[i].trim() === "") continue;
        if (body[i].match(/^\s*/)[0].length <= cfgIndent.length) { e = i; break; }
      }
      const child = body.slice(tsIdx + 1, e);
      const aIdx = child.findIndex((l) => new RegExp(`^${childIndent}autoTailscale:`).test(l));
      const line = `${childIndent}autoTailscale: ${values.autoTailscale}`;
      if (aIdx >= 0) child[aIdx] = line;
      else child.push(line);
      body = [...body.slice(0, tsIdx + 1), ...child, ...body.slice(e)];
    }
  }

  const head = lines.slice(0, idIdx);
  const idLine = block[0];
  const between = cfgRel >= 0 ? block.slice(1, cfgRel) : block.slice(1);
  const tail = lines.slice(endIdx);

  const out = [...head, idLine, ...between, `${propIndent}config:`, ...body, ...tail];
  let text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  if (wasCRLF) text = text.replace(/\n/g, "\r\n");

  try {
    writeFileSync(file, text, "utf8");
  } catch (e) {
    return { ok: false, message: `写入失败：${e.message}` };
  }
  const needRestart = values.bridgePort !== undefined || values.cliPort !== undefined;
  return { ok: true, message: "已保存" + (needRestart ? "，端口改动需重启 DSH 生效" : "，重启 DSH 后生效") };
}

export function apply(ctx, config = {}) {
  // 作为 cookie-minter 自己被拉起时（一个裸 `dsh web`），不能递归再拉 bridge。
  if (process.env.DSH_PHONE_AS_MINTER) return;

  const logger = (ctx && ctx.logger ? ctx.logger("phone-remote") : null) || console;
  const info = (m) => { try { logger.info?.(m); } catch { console.log(m); } };
  const warn = (m) => { try { logger.warn?.(m); } catch { console.warn(m); } };

  const envNum = (k) => (process.env[k] ? Number(process.env[k]) : NaN);
  const tsCfg = config.tailscale && typeof config.tailscale === "object" ? config.tailscale : {};
  const cfg = {
    bridgePort: envNum("DSH_PHONE_BRIDGE_PORT") || Number(config.bridgePort) || 8124,
    cliPort: envNum("DSH_PHONE_CLI_PORT") || Number(config.cliPort) || 8090,
    minter: config.minter !== false,
    trustedHost: String(config.trustedHost || ""),
    serve: process.env.DSH_PHONE_NO_SERVE ? false : config.serve !== false,
    dshBin: pickBin(String(config.dshBin || ""), dshCandidates(), "dsh"),
    tailscaleBin: pickBin(String(config.tailscaleBin || ""), TS_CANDIDATES, "tailscale"),
    autoTailscale: process.env.DSH_PHONE_NO_TAILSCALE ? false : tsCfg.enabled !== false,
    autoUp: tsCfg.autoUp !== false,
    autoLogin: tsCfg.autoLogin !== false,
    openLoginBrowser: tsCfg.openLoginBrowser === true,
    // 预授权密钥（tskey-auth-…）：配上就完全免手动登录
    authKey: String(tsCfg.authKey || process.env.DSH_PHONE_TS_AUTHKEY || "").trim(),
    serveRetryMs: Number(tsCfg.serveRetryMs) || 60000,
    upTimeoutMs: Number(tsCfg.upTimeoutMs) || 25000,
    // DSH 关闭时是否把 Tailscale 一起停掉。默认 false（不停）。
    // 原因：手机端 TailscaleVpnService 没有任何保活/重连定时器，
    // MainActivity 的 ticker 只在 resumed 时跑（后台完全不 poll），
    // 所以 PC 这边一 `tailscale down` + `sc stop Tailscale`，手机侧的
    // libtailscale 引擎就会掉线并且不会自己恢复 —— 表现为「一直连不上」，
    // 必须人拿手机重开 App。为了不让 DSH 的每次重启都打断手机，
    // 只有显式写 stopOnExit: true 时才在退出时拆隧道。
    // 顶层字段是设置页可保存的那个；tailscale.stopOnExit 保留兼容老配置。
    stopOnExit: config.stopOnExit === true || tsCfg.stopOnExit === true,
  };
  cfg.upTimeoutMs = Math.max(5000, Math.min(cfg.upTimeoutMs, 120000));
  cfg.serveRetryMs = Math.max(15000, cfg.serveRetryMs);

  const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const children = { bridge: null, minter: null };
  let stopped = false;
  let serveDone = false;
  let serveBusy = false;
  let serveRetryAt = 0;
  let watchBusy = false;
  let tsBusy = false;
  let lastTsState = "";
  let loginOffered = false;
  // 上次写进登录提示文件的那条链接。用来判断"链接是不是换了"，换了才重写文件。
  let lastLoginUrl = "";

  // minter 的失败要能被面板看见。
  //
  // 之前它的死活只写在 ~/.dsh/logs/dsh-web-serve.log 里，而面板上看到的永远是
  // 一条「登录签发端口 · 未运行」—— 用户没有理由去翻那个文件。现在把最后一条
  // 失败原因挂到 state 上，配合「重启桥接」按钮就能自助修复。
  let minterError = "";
  let minterSpawnedAt = 0;
  // 下一轮最早什么时候可以再拉 minter。启动失败时指数退避，免得每 30 秒
  // 白起一个注定失败的进程把日志刷满。
  let minterRetryAt = 0;
  let minterFails = 0;

  // 用户主动「退出账号」后挂起自动连接。
  //
  // 为什么必须挂起：看门狗每 30 秒跑一轮 ensureTunnel()，而 NeedsLogin 分支
  // 只要识别到没登录就会（带 authKey 时）自动 `tailscale up` —— 用户刚退出的
  // 账号会在半分钟内被同一把 authKey 登回去，按钮看起来"没生效"。
  // 这里用一个显式闸门挡住整条隧道链路（含 NeedsLogin 分支），而不是只关 autoUp。
  let tsPaused = false;

  // ---- 小工具 ---------------------------------------------------------

  /** 跑一条外部命令，永不 reject。 */
  function run(bin, args, { timeout = 15000 } = {}) {
    return new Promise((resolve) => {
      execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : (err ? -1 : 0),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          message: err ? String(err.message || "") : "",
        });
      });
    });
  }

  const portBusy = (port) => new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1500, () => done(false));
  });

  const alive = (k) => {
    const c = children[k];
    return !!(c && c.exitCode === null && !c.killed);
  };

  const track = (k, child, label) => {
    children[k] = child;
    child.on("exit", (code, sig) => {
      if (children[k] === child) children[k] = null;
      if (!stopped) warn(`${label} 已退出 (code=${code} sig=${sig})，稍后重启`);
    });
    child.on("error", () => {
      if (children[k] === child) children[k] = null;
    });
  };

  /** 主动结束一个受管子进程（隧道掉线时收 bridge 用）。 */
  function killChild(k) {
    const c = children[k];
    if (!c) return;
    children[k] = null;
    try {
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(c.pid), "/T", "/F"], { timeout: 3000 }, () => {});
      } else {
        c.kill("SIGTERM");
      }
    } catch {}
  }

  // ---- Tailscale ------------------------------------------------------

  /** `tailscale status --json`；daemon 不可达时 ok=false。 */
  async function tsStatus() {
    const r = await run(cfg.tailscaleBin, ["status", "--json"], { timeout: 10000 });
    if (!r.ok) {
      const msg = (r.stderr || r.message || "").trim().split("\n")[0];
      return { ok: false, error: msg || `exit ${r.code}` };
    }
    try {
      return { ok: true, json: JSON.parse(r.stdout) };
    } catch {
      return { ok: false, error: "status --json 返回非 JSON" };
    }
  }

  /**
   * 确保 tailscaled 在跑；没跑就拉起 Windows 服务。
   *
   * 服务被设为 Manual（不开机自启），所以 DSH 启动时它通常是 STOPPED，
   * 这里负责把它拉起来。DSH 以管理员身份运行（安装目录 exe 的兼容性里
   * 勾了「以管理员身份运行」），sc start 一定能成。
   *
   * 即使某次是非管理员，服务 ACL 里 BU 也有 SERVICE_START 权限，
   * 启动这条一般也能成功；只有停止需要管理员。
   */
  async function ensureDaemon() {
    let st = await tsStatus();
    if (st.ok) return st;

    // 先看看服务在不在、什么状态，日志里留下证据
    const before = await run("sc.exe", ["query", "Tailscale"], { timeout: 8000 });
    const wasStopped = /STOPPED/i.test(before.stdout);
    info(`Tailscale 守护进程不可达（${st.error}）；服务状态：${wasStopped ? "STOPPED" : "未知/运行中但无响应"}，尝试启动…`);

    const startRes = await run("sc.exe", ["start", "Tailscale"], { timeout: 25000 });
    if (!startRes.ok) {
      const why = (startRes.stderr || startRes.message || "").trim().split("\n")[0];
      // 1056 = 服务已在运行
      if (!/1056|already been started/i.test(why)) {
        warn(`sc start 失败：${why}`);
      }
    }

    for (let i = 0; i < 15; i++) {
      await sleep(1500);
      st = await tsStatus();
      if (st.ok) { info("Tailscale 服务已启动"); return st; }
    }

    warn("Tailscale 服务仍未就绪。请检查："
      + "① 服务是否被禁用（sc qc Tailscale）；"
      + "② Tailscale 安装是否完整。");
    return st;
  }

  /**
   * 停掉隧道：先 tailscale down（断开），再 sc stop（收掉服务进程）。
   *
   * 两步的分工：
   *   · `tailscale down` 只改 daemon 的 WantRunning，普通权限就能做；
   *   · `sc stop` 需要管理员。DSH 若以管理员身份启动（安装目录 exe 的
   *     兼容性里勾了「以管理员身份运行」），这里就能把服务也停干净，
   *     开机后不占内存、不留后台进程。
   *
   * 即使 sc stop 失败（非管理员），隧道也已经断了，手机会连不上 ——
   * 功能上不受影响，只是 tailscaled.exe 会驻留成 Idle。
   */
  async function stopTunnel() {
    const r = await run(cfg.tailscaleBin, ["down"], { timeout: 15000 });
    if (r.ok) info("隧道已断开（tailscale down）");
    else warn(`tailscale down 失败：${(r.stderr || r.message).trim().split("\n")[0]}`);

    const s = await run("sc.exe", ["stop", "Tailscale"], { timeout: 25000 });
    if (s.ok) {
      // 等服务真的停下来，最多 15 秒
      for (let i = 0; i < 10; i++) {
        await sleep(1500);
        const q = await run("sc.exe", ["query", "Tailscale"], { timeout: 8000 });
        if (/STOPPED/i.test(q.stdout)) { info("Tailscale 服务已停止"); return; }
      }
      info("已发出停止指令，服务正在退出");
    } else {
      info("Tailscale 服务保持驻留（当前非管理员，不影响手机连接状态）");
    }
  }

  /** 把"需要登录"的提示写成文件，方便直接点开。 */
  function offerLogin(url, reason) {
    if (!cfg.autoLogin) return;
    // 链接换了就要重写：status 里的 AuthURL 会随每次 `tailscale up` 变，
    // 只写一次的话磁盘上留着的会是第一版，过期后又被面板当兜底读出来（404）。
    const changed = !!url && url !== lastLoginUrl;
    if (loginOffered && !changed) return;
    loginOffered = true;
    if (url) lastLoginUrl = url;
    const file = logFile("dsh-phone-remote-login.txt");
    const body = [
      "DSHgo / phone-remote：Tailscale 需要登录一次。",
      "",
      url ? `登录链接：${url}` : "没拿到登录链接，请手动执行：tailscale up",
      "",
      "登录成功后凭据保存在本机，以后只要开 dsh，插件就会自动把 Tailscale 拉起来，",
      "不需要再手动打开 Tailscale。",
      "",
      reason ? `（${reason}）` : "",
      "",
    ].join("\r\n");
    try { writeFileSync(file, body, "utf8"); } catch {}
    if (url) {
      warn(`Tailscale 需要登录一次：${url}`);
      warn(`登录链接也已写入 ${file}`);
      if (cfg.openLoginBrowser) {
        try {
          spawnCmd("start", ["", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
        } catch {}
      }
    } else {
      warn("Tailscale 需要登录，但没拿到登录链接；请手动执行 `tailscale up`");
    }
  }

  /** 确保隧道 Running：必要时 `tailscale up`。 */
  async function ensureTunnel() {
    const st = await ensureDaemon();
    if (!st.ok) return { state: "unreachable", detail: st.error };

    const j = st.json || {};
    const backend = String(j.BackendState || "");
    if (backend !== lastTsState) {
      lastTsState = backend;
      const name = j.Self && j.Self.DNSName ? ` ${j.Self.DNSName}` : "";
      info(`Tailscale 状态：${backend || "(空)"}${name}`);
    }

    if (backend === "Running") return { state: "running", json: j };
    if (backend === "Starting") return { state: "starting", json: j };

    if (backend === "NeedsLogin") {
      // 首次使用 / 凭据被清空：需要点一次登录。凭据持久化之后就再也不用管了。
      // 配了 authKey 的话，这里直接自动登录，连点都不用点。
      // 同样必须带 --unattended（理由见下面 Stopped 分支的注释）。

      // ⚠️ 已经有一条待授权链接时，不要再 `tailscale up` 一次。
      //
      // 每跑一次 up，tailscaled 就重新签发一个 login code，`status --json` 的
      // AuthURL 随之变掉。看门狗 30 秒一轮，于是面板上的链接每 30 秒换一个字符
      // 串 —— 用户复制/点开的瞬间它就已经不是"最新"的那条了，体感是「点了没用」。
      // 链接本身并不会被上游作废（旧 code 仍能打开登录页），但让面板显示一条
      // 不再变化的链接，用户才可能真的把它点完。
      const live = String(j.AuthURL || "");
      if (live && !cfg.authKey) {
        offerLogin(live, "状态 NeedsLogin");
        return { state: "needs-login", json: j };
      }

      const upArgs = ["up", "--timeout", "5s", "--unattended"];
      if (cfg.authKey) upArgs.splice(1, 0, `--auth-key=${cfg.authKey}`);
      const up = await run(cfg.tailscaleBin, upArgs, { timeout: 20000 });
      const text = `${up.stdout}\n${up.stderr}`;
      if (up.ok) {
        const after = await tsStatus();
        const b2 = after.ok ? String((after.json || {}).BackendState || "") : "";
        info(`已用 authKey 自动登录，当前状态 ${b2 || "(未知)"}`);
        return { state: b2 === "Running" ? "running" : "starting", json: after.ok ? after.json : undefined };
      }
      const m = text.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/);
      offerLogin(m ? m[0] : "", "状态 NeedsLogin");
      return { state: "needs-login", json: j };
    }

    // Stopped / NoState / 其它：WantRunning=false 时 `tailscale up` 把它拉起来。
    //
    // ⚠️ 关键坑：只要本机改过任何「非默认」pref（我们设过 --unattended，也就是
    // ForceDaemon=true），`tailscale up` 就必须把所有非默认项重新声明一遍，否则
    // 它会直接报错退出：
    //   Error: changing settings via 'tailscale up' requires mentioning all
    //   non-default flags. To proceed, either re-run your command with --reset
    //   or use the command below ...: tailscale up --unattended
    // 所以这里显式带 --unattended，和 set --unattended=true 保持一致。
    if (cfg.autoUp) {
      const args = ["up", "--timeout", `${Math.round(cfg.upTimeoutMs / 1000)}s`, "--unattended"];
      if (cfg.authKey) args.splice(1, 0, `--auth-key=${cfg.authKey}`);
      const up = await run(cfg.tailscaleBin, args, { timeout: cfg.upTimeoutMs + 5000 });
      if (!up.ok) {
        const text = `${up.stdout}\n${up.stderr}`;
        const m = text.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/);
        if (m) {
          offerLogin(m[0], "tailscale up 要求登录");
        } else if (/requires mentioning all non-default flags/i.test(text)) {
          // 兜底：换用 --reset 强制按默认值重连（会清掉我们设的 unattended，
          // 下一轮再 set 回来）
          warn("tailscale up 因非默认 pref 冲突失败，改用 --reset 重试");
          const r2 = await run(cfg.tailscaleBin,
            ["up", "--reset", "--timeout", `${Math.round(cfg.upTimeoutMs / 1000)}s`],
            { timeout: cfg.upTimeoutMs + 5000 });
          if (r2.ok) {
            await run(cfg.tailscaleBin, ["set", "--unattended=true"], { timeout: 15000 });
            const a2 = await tsStatus();
            const bb = a2.ok ? String((a2.json || {}).BackendState || "") : "";
            info(`tailscale up --reset 完成，当前状态 ${bb || "(未知)"}`);
            return { state: bb === "Running" ? "running" : "starting", json: a2.ok ? a2.json : undefined };
          }
        } else {
          const first = text.trim().split("\n")[0];
          warn(`tailscale up 未成功：${first || up.message}`);
        }
        return { state: "down", detail: text };
      }
      const after = await tsStatus();
      const b2 = after.ok ? String((after.json || {}).BackendState || "") : "";
      info(`tailscale up 完成，当前状态 ${b2 || "(未知)"}`);
      return { state: b2 === "Running" ? "running" : "starting", json: after.ok ? after.json : undefined };
    }
    return { state: "down", json: j };
  }

  /** `tailscale serve --bg <port>`，幂等；已配置就跳过。 */
  async function publishServe() {
    if (stopped || serveBusy) return;
    if (Date.now() < serveRetryAt) return;
    serveBusy = true;
    try {
      const cur = await run(cfg.tailscaleBin, ["serve", "status", "--json"], { timeout: 10000 });
      const body = cur.ok ? cur.stdout.trim() : "";
      const already = new RegExp(`127\\.0\\.0\\.1:${cfg.bridgePort}(?!\\d)`).test(body);
      if (already) {
        serveDone = true;
        info(`tailscale serve 已指向 :${cfg.bridgePort}，跳过`);
        return;
      }

      const r = await run(cfg.tailscaleBin, ["serve", "--bg", String(cfg.bridgePort)], { timeout: 20000 });
      if (r.ok) {
        serveDone = true;
        info(`tailscale serve -> :${cfg.bridgePort}`);
        return;
      }

      const text = (r.stderr || r.stdout || r.message || "").trim();
      const first = text.split("\n")[0] || "(无输出)";
      serveRetryAt = Date.now() + cfg.serveRetryMs;

      // 首次用 serve 时 tailnet 需要账号主人点一次批准；命令会挂着等，所以上一轮
      // 的超时也可能落在这里。把批准链接捞出来写进文件，比只报错有用得多。
      const approve = text.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9]+/);
      if (approve) {
        // 这个闸门只能由人打开：再试一百次也是同一句「not enabled」。把重试间隔
        // 拉到 10 分钟，免得每 60 秒白起一个挂着等批准的子进程。
        serveRetryAt = Date.now() + Math.max(cfg.serveRetryMs, 10 * 60 * 1000);
        const file = logFile("dsh-phone-remote-serve.txt");
        try {
          writeFileSync(file, [
            "DSHgo / phone-remote：tailnet 还没启用 Serve。",
            "",
            `批准链接：${approve[0]}`,
            "",
            "点开后按提示启用，插件会在下一轮自动重试。",
            "另外确认 https://login.tailscale.com/admin/dns 里 HTTPS Certificates 已开启。",
            "",
          ].join("\r\n"), "utf8");
        } catch {}
        warn(`tailscale serve 需要先批准：${approve[0]}`);
        warn(`批准链接已写入 ${file}`);
      } else if (/does not support getting TLS certs|HTTPS.*(disabled|not enabled)|enable HTTPS|requires HTTPS/i.test(text)) {
        warn("tailscale serve 失败：tailnet 还没开启 HTTPS。"
          + "去 https://login.tailscale.com/admin/dns 打开 HTTPS Certificates，之后插件会自动重试。");
      } else if (/logged out|NeedsLogin|not logged in/i.test(text)) {
        warn(`tailscale serve 失败（未登录）：${first}`);
      } else {
        warn(`tailscale serve 失败：${first}`);
      }
    } catch (e) {
      serveRetryAt = Date.now() + cfg.serveRetryMs;
      warn(`publishServe 异常：${e && e.message}`);
    } finally {
      serveBusy = false;
    }
  }

  /** 写一份状态快照，方便排查。 */
  async function writeStatusSnapshot() {
    try {
      const st = await tsStatus();
      const j = st.ok ? st.json : {};
      writeFileSync(logFile("dsh-phone-remote-status.json"), JSON.stringify({
        at: new Date().toISOString(),
        tailscale: {
          reachable: st.ok,
          error: st.ok ? undefined : st.error,
          backendState: j.BackendState,
          dnsName: j.Self && j.Self.DNSName,
          ips: j.TailscaleIPs || [],
        },
        bridgePort: cfg.bridgePort,
        cliPort: cfg.cliPort,
        serveDone,
        bridgeAlive: alive("bridge"),
        minterAlive: alive("minter"),
        // 面板据此显示「登录签发失败：dsh: startup failed: …」而不是干巴巴的
        // 「未运行」。留空表示没有已知错误。
        minterError: minterError || checkMinterLog(),
        minterProfile: MINTER_PROFILE,
      }, null, 2), "utf8");
    } catch {}
  }

  // ---- 子进程 ---------------------------------------------------------

  async function spawnBridge() {
    if (stopped) return;
    try {
      const script = path.join(pkgDir, "bridge", "dsh-phone-proxy.cjs");
      const fd = openSync(logFile("dsh-phone-remote.log"), "a");
      const child = spawn(process.execPath, [script], {
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: {
          ...process.env,
          // 桌面版里 process.execPath 是 Electron 主程序，必须让它以 node 模式跑脚本
          ELECTRON_RUN_AS_NODE: "1",
          DSH_PHONE_PORT: String(cfg.bridgePort),
          DSH_PHONE_CLI_PORT: String(cfg.cliPort),
          ...(process.env.DSH_PHONE_CLI_LOG ? { DSH_PHONE_CLI_LOG: process.env.DSH_PHONE_CLI_LOG } : {}),
        },
      });
      closeSync(fd);
      track("bridge", child, `bridge :${cfg.bridgePort}`);
      info("bridge 已启动（app 端口自动探测）");
    } catch (e) {
      warn(`bridge 启动失败（将重试）：${e && e.message}`);
    }
  }

  async function spawnMinter() {
    if (stopped) return;
    try {
      // 用插件自己的干净 profile，而不是用户的 `web`。见 MINTER_PROFILE 的注释：
      // 用户的 profile 会被 dsh-fix / 插件管理器写进 `disabled: true`，那样
      // `dsh web` 必然启动失败，minter 一死手机就永远停在等待页。
      const prof = ensureMinterProfile();
      if (!prof.ok) {
        minterError = `minter profile 建不出来：${prof.message}`;
        warn(minterError);
        return;
      }
      if (prof.changed) info(`已重建 minter profile：${prof.dir}（${prof.files.join(", ")}）`);

      const args = [
        "--profile", MINTER_PROFILE,
        "--host", "127.0.0.1",
        "--port", String(cfg.cliPort),
        "--no-open",
      ];
      if (cfg.trustedHost) args.push("--trusted-host", cfg.trustedHost);

      const minterLog = process.env.DSH_PHONE_CLI_LOG || logFile("dsh-web-serve.log");
      const fd = openSync(minterLog, "w"); // 截断：只保留一条有效 token 序列

      // dsh.cmd 自己会设 ELECTRON_RUN_AS_NODE=1；这里必须先摘掉继承来的值，
      // 否则空串在某些 Electron 版本里仍被当成已设置。
      const env = { ...process.env, DSH_PHONE_AS_MINTER: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      // 显式钉住 profile 名：savePatchConfig / 日志都用它，别让继承来的
      // DSH_PROFILE（可能是 desktop）把 minter 引到别的 profile 上。
      env.DSH_PROFILE = MINTER_PROFILE;

      const child = spawnCmd(cfg.dshBin, args, {
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env,
      });
      closeSync(fd);
      track("minter", child, `minter :${cfg.cliPort}`);
      minterSpawnedAt = Date.now();
      minterError = "";
      info(`minter 已启动 :${cfg.cliPort}（profile ${MINTER_PROFILE}）`);
    } catch (e) {
      minterError = `minter 启动失败：${e && e.message}`;
      warn(`${minterError}（将重试）`);
    }
  }

  /**
   * minter 是不是"活着但没用"：进程在、端口也在听，可日志里全是启动失败。
   *
   * 只看 alive("minter") 会被骗 —— dsh 失败退出前照样会占住端口一小会儿，
   * 而且 dsh.cmd 是 cmd.exe 的子进程，父进程活着的判据并不等于 `dsh web`
   * 真的在服务。所以再读一眼日志尾巴：出现 startup failed 就算失败。
   */
  function checkMinterLog() {
    if (process.env.DSH_PHONE_CLI_LOG) return "";
    try {
      const f = logFile("dsh-web-serve.log");
      if (!existsSync(f)) return "";
      const text = readFileSync(f, "utf8");
      if (!/startup failed|did not activate|Cannot find|Error:/i.test(text)) return "";
      // 只取最有用的一行：失败摘要本身。
      const m = text.match(/dsh: startup failed[^\r\n]*/);
      if (m) return m[0];
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.length ? lines[lines.length - 1].slice(0, 200) : "";
    } catch { return ""; }
  }

  // ---- 看门狗 ---------------------------------------------------------

  async function watch() {
    if (stopped || watchBusy) return;
    watchBusy = true;
    try {
      let ts = { state: "skipped" };
      if (cfg.autoTailscale && !tsPaused) {
        if (!tsBusy) {
          tsBusy = true;
          try { ts = await ensureTunnel(); } finally { tsBusy = false; }
        }
      }
      const tsReady = !cfg.autoTailscale || (ts.state === "running" && !tsPaused);

      // bridge 必须在隧道就绪**之后**才启动。
      //
      // 原因：bridge 启动时会扫本机网卡，找 100.x 的 tailnet 地址并在上面
      // 额外开一个 listener（手机通过它访问 inspector / 本地端口穿透）。
      // 如果隧道还没起，Tailscale 网卡不存在，那次 listen 就静默失败
      // （错误只打进 bridge 自己的日志），结果就是 127.0.0.1:8124 能连、
      // 100.x:8124 连不上 —— 手机端表现为「连不上」但面板显示一切正常。
      //
      // 所以要等 tsReady 再拉 bridge；隧道掉了就把 bridge 也收掉，
      // 等恢复后重新拉起，让网卡名同时存在。
      if (tsReady) {
        // 先判断「进程还在但端口不通」：dsh 启动失败时 dsh.cmd 的 cmd.exe 外壳
        // 有时会比里面的 node 多活几秒，光看 alive() 会以为它还在正常工作。
        if (alive("minter") && minterSpawnedAt && Date.now() - minterSpawnedAt > 12000
            && !(await portBusy(cfg.cliPort))) {
          const err = minterError || checkMinterLog() || "minter 进程在但端口没有在听";
          minterError = err;
          minterFails += 1;
          minterRetryAt = Date.now() + Math.min(300000, 30000 * Math.pow(2, minterFails - 1));
          warn(`minter 无效，先收掉：${err}`);
          killChild("minter");
          minterSpawnedAt = 0;
        }

        if (!alive("bridge") && !(await portBusy(cfg.bridgePort))) await spawnBridge();
        if (cfg.minter && !alive("minter") && Date.now() >= minterRetryAt
            && !(await portBusy(cfg.cliPort))) {
          // 端口被别人占着时不硬拉：那多半是上一只还没退干净的 minter。
          await spawnMinter();
          // 起来 8 秒后再回来看一眼日志，失败就退避（30s → 60s → …，上限 5 分钟）。
          setTimeout(() => {
            if (stopped || !minterSpawnedAt) return;
            const err = minterError || checkMinterLog();
            if (err) {
              minterError = err;
              minterFails += 1;
              minterRetryAt = Date.now() + Math.min(300000, 30000 * Math.pow(2, minterFails - 1));
              warn(`minter 启动后仍不可用：${err}（${Math.round((minterRetryAt - Date.now()) / 1000)}s 后重试）`);
            } else {
              minterFails = 0;
              minterRetryAt = 0;
            }
          }, 8000).unref?.();
        }
      } else if (alive("bridge")) {
        // 隧道掉了：停掉 bridge，避免它长期只绑定 127.0.0.1
        info("隧道未就绪，停止 bridge 等待重连");
        killChild("bridge");
      }

      if (cfg.serve) {
        if (tsReady && alive("bridge")) {
          if (!serveDone) await publishServe();
        } else {
          // 隧道掉了：serve 配置可能随节点重登失效，等恢复后重新发布
          serveDone = false;
        }
      }
      void writeStatusSnapshot();
    } catch (e) {
      warn(`watch 异常：${e && e.message}`);
    } finally {
      watchBusy = false;
    }
  }

  // ---- 收尾 -----------------------------------------------------------

  function disposeAll() {
    stopped = true;
    for (const k of Object.keys(children)) {
      const child = children[k];
      if (!child) continue;
      try {
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 3000 }, () => {});
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
      children[k] = null;
    }

    // DSH 关闭 → 隧道跟着关。
    //
    // 用 tailscale down 而不是 sc stop 作为主手段：DSH 是 asInvoker（普通权限），
    // 停 Windows 服务需要管理员，而 tailscale down 只改 daemon 的 WantRunning，
    // 普通权限就能做，效果一样（隧道断开、手机连不上）。
    // sc stop 作为可选加菜：万一 DSH 是以管理员启动的，就把服务也收掉。
    //
    // 服务已设为 Manual 启动，所以开机不会被拉起；下次开 DSH 时
    // ensureDaemon() 会用 sc start 重新拉起它（BU 有 SERVICE_START 权限）。
    if (cfg.stopOnExit && cfg.autoTailscale) {
      info("DSH 关闭，正在断开 Tailscale 隧道…");
      void stopTunnel();
    }

    info("已停止");
  }

  try {
    info(`ready（bridge :${cfg.bridgePort}, cli :${cfg.cliPort}, `
      + `serve ${cfg.serve ? "on" : "off"}, tailscale ${cfg.autoTailscale ? "托管" : "手动"}）`);
    info(`dshBin=${cfg.dshBin}`);
    info(`tailscaleBin=${cfg.tailscaleBin}`);
    void watch();
    const timer = setInterval(() => void watch(), 30000);
    if (timer.unref) timer.unref();
    if (ctx && typeof ctx.effect === "function") {
      ctx.effect(() => () => { clearInterval(timer); disposeAll(); });
    }

    // 设置页 UI 的后端：注册 /phone-remote/* 路由，给 client 卡片读写状态。
    // 只有 web 宿主才挂得上；tui/headless 下 registerUiRoutes 返回 null。
    //
    // 用 ctx.inject 而不是直接摸 ctx.webServer：webServer 可能比本插件晚就位，
    // 直接读会拿到 undefined 而静默跳过。inject 会在服务可用时再回调。
    try {
      const uiCfg = {
        tailscaleBin: cfg.tailscaleBin,
        bridgePort: cfg.bridgePort,
        cliPort: cfg.cliPort,
        serve: cfg.serve,
        autoTailscale: cfg.autoTailscale,
        // 可视化设置保存：写回 profile 的 cordis.patch.yml
        saveConfig: (values) => savePatchConfig(values),
        // 保存后立刻作用到运行中的实例：否则退出时用的还是启动那一刻的旧值。
        applyRuntime: (values) => {
          if (values.stopOnExit !== undefined) cfg.stopOnExit = values.stopOnExit === true;
          if (values.serve !== undefined) cfg.serve = values.serve !== false;
          if (values.autoTailscale !== undefined) cfg.autoTailscale = values.autoTailscale !== false;
          if (values.bridgePort !== undefined) cfg.bridgePort = Number(values.bridgePort) || cfg.bridgePort;
          if (values.cliPort !== undefined) cfg.cliPort = Number(values.cliPort) || cfg.cliPort;
        },
        // 让设置页的「重启桥接」能真正重启子进程
        restart: async () => {
          const kill = (k) => {
            const c = children[k];
            if (!c) return;
            children[k] = null;
            try {
              if (process.platform === "win32") execFile("taskkill", ["/PID", String(c.pid), "/T", "/F"], { timeout: 3000 }, () => {});
              else c.kill("SIGTERM");
            } catch {}
          };
          kill("bridge");
          kill("minter");
          // 「重启桥接」是用户的自助按钮：把 minter 的退避与上次错误一起清掉，
          // 否则刚失败过的实例会顶着一个 5 分钟的闸门，点了像没反应。
          minterError = "";
          minterFails = 0;
          minterRetryAt = 0;
          minterSpawnedAt = 0;
          await sleep(1500);
          await spawnBridge();
          if (cfg.minter) await spawnMinter();
          return { ok: true, message: "桥接与登录签发已重启" };
        },
        // 退出账号时的联动：隧道一断，bridge/minter 就没有存在意义了（bridge 只在
        // 网卡存在时才能绑上 100.x，隧道没了它只会守着 127.0.0.1）。主动收掉，
        // 顺手清掉 serve 标记，这样重新登录后 publishServe() 会重新发一次。
        afterLogout: async () => {
          tsPaused = true;
          serveDone = false;
          loginOffered = false;
          killChild("bridge");
          killChild("minter");
          info("已退出 Tailscale 账号，自动连接已挂起（点「连接」可恢复）");
        },
        // 挂起状态的读写：ui-routes 用它挡住看门狗，也能在 state 里讲清楚。
        getPaused: () => tsPaused,
        setPaused: (v) => { tsPaused = v === true; },
        // 用户重新登录/恢复自动连接。
        resumeTunnel: () => {
          tsPaused = false;
          serveDone = false;
          serveRetryAt = 0;
          return { ok: true, message: "自动连接已恢复" };
        },
      };

      const mountUi = (hostCtx) => {
        const ui = registerUiRoutes(hostCtx, uiCfg);
        if (!ui) return;
        info("设置页接口已挂载：/phone-remote/state");
        if (hostCtx && typeof hostCtx.effect === "function") {
          hostCtx.effect(() => () => { try { ui.dispose && ui.dispose(); } catch {} });
        } else if (ui.dispose && ctx && typeof ctx.effect === "function") {
          ctx.effect(() => () => { try { ui.dispose(); } catch {} });
        }
      };

      if (ctx && typeof ctx.inject === "function") {
        // 声明式等待 webServer 就位
        ctx.inject(["webServer"], (c) => mountUi(c));
      } else {
        mountUi(ctx);
      }
    } catch (e) {
      warn(`设置页接口挂载失败（不影响隧道）：${e && e.message}`);
    }
  } catch (e) {
    warn(`init 异常（非致命）：${e && e.message}`);
  }
}
