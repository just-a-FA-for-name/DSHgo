// dsh-phone-remote — DSHgo phone remote, PC side, as a dsh plugin.
//
// Everything the old loose scripts did (dsh-web-serve.bat / bridge-loop.bat)
// but inside dsh: on startup the plugin brings up the whole phone→PC chain and
// keeps it alive.
//
//   minter  `dsh web` on 127.0.0.1:<cliPort> — prints the login token that the
//           bridge reads from ~/.dsh/logs/dsh-web-serve.log
//   bridge  node bridge/dsh-phone-proxy.cjs on 127.0.0.1:<bridgePort> — the
//           entry point tailscale serve publishes to the phone
//   serve   `tailscale serve --bg <bridgePort>` (best effort, idempotent)
//
// Design rule: this plugin touches NO dsh internals and imports NO dsh
// packages — just the plain `apply(ctx, config)` plugin form and node
// builtins. That is why it survives dsh version updates: it only supervises
// child processes through the public CLI surface.
//
// Config (all optional, via cordis.patch.yml):
//   bridgePort   8124   phone traffic entry (phone app default)
//   cliPort      8123   cookie-minting `dsh web` instance
//   minter       true   set false if you already run `dsh web` yourself
//   trustedHost  ""     forwarded to `dsh web --trusted-host <host>`
//   serve        true   set false to manage `tailscale serve` yourself
//   dshBin       "dsh"  path to the dsh CLI if it is not on PATH
//   tailscaleBin "tailscale"  path to the tailscale CLI
//
// Env overrides (used by tests, always win over config):
//   DSH_PHONE_BRIDGE_PORT / DSH_PHONE_CLI_PORT / DSH_PHONE_NO_SERVE
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSync, closeSync, mkdirSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";

import {resolveDshBin,serveRetryDelay} from "./runtime.js";

export const name = "phone-remote";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function logFile(file) {
  const dir = path.join(homeDir(), ".dsh", "logs");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, file);
}

export function apply(ctx, config = {}) {
  // When spawned as the cookie-minter itself (a bare `dsh web`), this plugin
  // must NOT recurse into itself and re-spawn bridges. The minter sets this
  // env var on its own process; we detect it and stand down immediately.
  if (process.env.DSH_PHONE_AS_MINTER) return;

  const logger = (ctx && ctx.logger ? ctx.logger("phone-remote") : null) || console;
  const info = (m) => { try { logger.info?.(m); } catch { console.log(m); } };
  const warn = (m) => { try { logger.warn?.(m); } catch { console.warn(m); } };

  const env = (k) => (process.env[k] ? Number(process.env[k]) : NaN);
  const cfg = {
    bridgePort: env("DSH_PHONE_BRIDGE_PORT") || Number(config.bridgePort) || 8124,
    cliPort: env("DSH_PHONE_CLI_PORT") || Number(config.cliPort) || 8090,
    minter: config.minter !== false,
    trustedHost: String(config.trustedHost || ""),
    serve: process.env.DSH_PHONE_NO_SERVE ? false : config.serve !== false,
    dshBin: resolveDshBin(config.dshBin),
    tailscaleBin: String(config.tailscaleBin || "tailscale"),
  };

  const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const children = { bridge: null, minter: null };
  let stopped = false;
  let serveDone = false;
  let serveBusy = false;
  let serveFailures=0,nextServeAt=0;
  let watchBusy = false;

  // ---- ports ----------------------------------------------------------

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
      if (!stopped) warn(`${label} exited (code=${code} sig=${sig}); will restart`);
    });
    child.on("error", () => {
      if (children[k] === child) children[k] = null;
    });
  };

  // ---- children -------------------------------------------------------

  async function spawnBridge() {
    if (stopped) return;
    try {
      const script = path.join(pkgDir, "bridge", "dsh-phone-proxy.cjs");
      // The bridge discovers the app's web port by itself at startup (cookie
      // probe across the process's listeners — it may host several roots).
      const fd = openSync(logFile("dsh-phone-remote.log"), "a"); // sync fd: spawn needs it now
      // hand the resolved ports to the bridge through its env knobs
      const child = spawn(process.execPath, [script], {
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: {
          ...process.env,
          DSH_PHONE_PORT: String(cfg.bridgePort),
          DSH_PHONE_CLI_PORT: String(cfg.cliPort),
          ...(process.env.DSH_PHONE_CLI_LOG ? { DSH_PHONE_CLI_LOG: process.env.DSH_PHONE_CLI_LOG } : {}),
        },
      });
      closeSync(fd);
      track("bridge", child, `bridge :${cfg.bridgePort}`);
      info("bridge started (app port auto-detected)");
      if (cfg.serve && !serveDone) publishServe();
    } catch (e) {
      warn(`bridge spawn failed (will retry): ${e && e.message}`);
    }
  }

  async function spawnMinter() {
    if (stopped) return;
    try {
      const args = ["web", "--host", "127.0.0.1", "--port", String(cfg.cliPort), "--no-open"];
      if (cfg.trustedHost) args.push("--trusted-host", cfg.trustedHost);
      // The bridge reads the login token from this log (the `dsh web: …?token=` line).
      // The stream is truncated so exactly one live token sequence exists at a time.
      const minterLog = process.env.DSH_PHONE_CLI_LOG || logFile("dsh-web-serve.log");
      const fd = openSync(minterLog, "w"); // truncate: one live token sequence
      const executable=process.platform==='win32'&&/\s/.test(cfg.dshBin)?'"'+cfg.dshBin.replace(/"/g,'')+'"':cfg.dshBin;
      const child = spawn(executable, args, {
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        shell: true,
        env: { ...process.env, DSH_PHONE_AS_MINTER: "1" },
      });
      closeSync(fd);
      track("minter", child, `minter :${cfg.cliPort}`);
      info(`minter started :${cfg.cliPort}`);
    } catch (e) {
      warn(`minter spawn failed (will retry): ${e && e.message}`);
    }
  }

  function publishServe() {
    if (stopped || serveBusy || Date.now()<nextServeAt) return;
    serveBusy = true;
    const tryBin = (bin) => new Promise((resolve) => {
      execFile(bin, ["serve", "--bg", String(cfg.bridgePort)], { timeout: 8000 }, (err) => resolve({ok:!err,missing:err?.code==='ENOENT'}));
    });
    (async () => {
      let result=await tryBin(cfg.tailscaleBin);
      if(result.missing && cfg.tailscaleBin!=="C:\\Program Files\\Tailscale\\tailscale.exe")result=await tryBin("C:\\Program Files\\Tailscale\\tailscale.exe");
      if(stopped){serveBusy=false;return;}
      if(result.ok){
        serveFailures=0;nextServeAt=0;
        serveDone = true;
        info(`tailscale serve -> :${cfg.bridgePort}`);
      } else {
        nextServeAt=Date.now()+serveRetryDelay(++serveFailures);
        if(serveFailures===1)warn("Tailscale Serve unavailable: check CLI, tailnet permissions/certificates, or disable serve for manual HTTP. Retrying with backoff.");
      }
      serveBusy = false;
    })();
  }

  // ---- watchdog -------------------------------------------------------

  async function watch() {
    if (stopped || watchBusy) return;
    watchBusy = true;
    try {
      if (!alive("bridge") && !(await portBusy(cfg.bridgePort))) await spawnBridge();
      if (cfg.minter && !alive("minter") && !(await portBusy(cfg.cliPort))) await spawnMinter();
      if (cfg.serve && !serveDone && alive("bridge")) publishServe();
    } catch (e) {
      warn(`watch error: ${e && e.message}`);
    } finally {
      watchBusy = false;
    }
  }

  // ---- teardown -------------------------------------------------------

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
    info("stopped");
  }

  try {
    info(`ready (bridge :${cfg.bridgePort}, cli :${cfg.cliPort}, serve ${cfg.serve ? "on" : "off"})`);
    void watch();
    const timer = setInterval(() => void watch(), 30000);
    if (timer.unref) timer.unref();
    if (ctx && typeof ctx.effect === "function") {
      ctx.effect(() => () => { clearInterval(timer); disposeAll(); });
    }
  } catch (e) {
    warn(`init error (non-fatal): ${e && e.message}`);
  }
}
