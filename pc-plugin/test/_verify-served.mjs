// 确认运行中的 GUI 真的在对外提供新版 client.js：
//   1. 连 /plugins/events（SSE）拿一帧 graph；
//   2. 从 graph 里取 dsh-phone-remote 的 rev；
//   3. 按 combo URL 取回脚本，检查"退出账号"之类的字样在不在。
import http from "node:http";

// GUI 端口会随 dsh 重启变化，所以不写死：优先命令行/env，其次探测常见端口，
// 最后从正在运行的 dsh 进程命令行里捞 --port。
const CANDIDATES = [
  process.argv[2],
  process.env.DSH_GUI_URL,
  "http://127.0.0.1:65431",
  "http://127.0.0.1:57960",
].filter(Boolean).map((s) => (s.startsWith("http") ? s : "http://127.0.0.1:" + s));

function probeState(base) {
  return new Promise((resolve) => {
    const req = http.get(base + "/phone-remote/state", (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? base : null);
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

let BASE = null;
for (const c of CANDIDATES) {
  BASE = await probeState(c);
  if (BASE) break;
}
if (!BASE) {
  console.log("SKIP  没找到运行中的 DSH GUI（试过 " + CANDIDATES.join(", ") + "）");
  console.log("      用法：node test/_verify-served.mjs [端口或 http://host:port]");
  process.exit(0);
}

function getSseFirstGraph(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + "/plugins/events", (res) => {
      let buf = "";
      const timer = setTimeout(() => { req.destroy(); reject(new Error("SSE 超时")); }, timeoutMs);
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        const m = buf.match(/^data: (\{.*\})$/m);
        if (m) {
          clearTimeout(timer);
          req.destroy();
          try { resolve(JSON.parse(m[1])); } catch (e) { reject(e); }
        }
      });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    req.on("error", reject);
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject);
  });
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

const frame = await getSseFirstGraph();
const graph = frame.graph || frame;
const row = (graph.entries || []).find((e) => e.id === "dsh-phone-remote");
check("graph 里有 dsh-phone-remote", !!row, row ? `rev=${row.rev}` : "missing");
check("graph 版本号已更新（HMR 已重建）", !!row && row.rev !== "0".repeat(12), row?.rev);

if (row) {
  const url = `${BASE}/plugins/??dsh-phone-remote/client.js&rev=${row.rev}`;
  const r = await getText(url);
  check("combo bundle 可取回", r.status === 200, `status=${r.status} len=${r.body.length}`);
  check("bundle 里含「退出账号」", r.body.includes("退出账号"));
  check("bundle 里含 confirm 步骤（确认退出账号？）", r.body.includes("确认退出账号"));
  check("bundle 里含账号行渲染（pr-account）", r.body.includes("pr-account"));
  check("bundle 里含 loggedOut 处理", r.body.includes("loggedOut"));
  check("bundle 里含 paused 处理", r.body.includes("paused"));
  check("bundle 里调用了 logout 路由", /api\("logout"/.test(r.body));
  check("bundle 里含 Serve 批准入口", r.body.includes("我已批准，重试"));
  check("bundle 里含 HTTPS 证书提示", r.body.includes("HTTPS Certificates"));
  // minter 起不来时面板必须说清楚，否则用户只会看到等待页而不知道去哪查。
  check("bundle 里含 minter 失败红字", r.body.includes("登录签发实例启动失败"));
  check("bundle 里含 minter 未运行提示", r.body.includes("登录签发实例未运行"));
  check("bundle 里读了 minterProfile", r.body.includes("minterProfile"));
  const graphs = await getText(`${BASE}/phone-remote/state`);
  check("state 路由仍可用", graphs.status === 200, `status=${graphs.status}`);
  // serve 段要能给出批准链接：这是 tailscale 唯一的启用入口，丢在 stdout 里
  // 用户就只剩一句「需要先批准 Serve」能动。
  let sv = null;
  try { sv = JSON.parse(graphs.body).serve || null; } catch {}
  check("state.serve 带 approveUrl / hint 字段", !!sv && "approveUrl" in sv && "hint" in sv,
    sv ? `configured=${sv.configured} hint=${sv.hint || "-"}` : "no serve");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(", "));
process.exit(failed.length ? 1 : 0);