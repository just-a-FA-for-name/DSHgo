// 验证 minter 用的干净 profile 会被正确创建 / 修复。
//
// 为什么需要这个测试：minter 起不来的根因是「复用用户自己的 web profile」，
// 而那个 profile 会被外部工具写进 `disabled: true`。修法是把 minter 挪到一个
// 插件自己维护的 profile 上。这里不去真的起 dsh（太慢、依赖安装状态），
// 只验证 profile 文件本身的生成规则：
//   1. 全新 HOME 能建出 4 个文件
//   2. 再跑一次是幂等的（不重写、changed=false）
//   3. package.json 的 bundles 被塞进第三方 bundle 时会被纠正回来
//   4. package.json 坏成非 JSON 时会被重建
//   5. 已有的 cordis.patch.yml 不会被覆盖（用户可能自己加了 patch）
//
// 做法：读源码、在末尾追加一行 export（ensureMinterProfile 是模块内函数），
// 写到临时 .mjs 再 import —— node 的 ESM 导出是只读的，没有别的办法拿到它。

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const srcFile = path.join(pkgDir, "lib", "index.js");

const failed = [];
const ok = [];
const T = (name, fn) => {
  try { fn(); ok.push(name); console.log(`PASS  ${name}`); }
  catch (e) { failed.push(`${name}: ${e && e.message}`); console.log(`FAIL  ${name}\n      ${e && e.message}`); }
};

const HOME = mkdtempSync(path.join(tmpdir(), "dsh-phone-minter-test-"));
const src = readFileSync(srcFile, "utf8");
// 探针文件写在 test\ 下，而源码里的 `./ui-routes.js` 是相对 lib\ 的 ——
// 换根目录就会解析到 test\ui-routes.js（不存在）。这里把它改写成绝对 file URL，
// 这样探针放哪儿都能加载。
const uiUrl = pathToFileURL(path.join(pkgDir, "lib", "ui-routes.js")).href;
const patched = src.replace('from "./ui-routes.js"', `from ${JSON.stringify(uiUrl)}`)
  + "\nexport { ensureMinterProfile, MINTER_PROFILE, MINTER_BUNDLES };\n";
const patchedFile = path.join(pkgDir, "test", ".minter-profile-probe.mjs");

// import 之前必须设好 DSH_HOME：模块顶层的 dshHome() 是函数，但 ensureMinterProfile
// 每次调用都会重新读环境变量，所以设了就生效。
process.env.DSH_HOME = HOME;

writeFileSync(patchedFile, patched, "utf8");
let mod;
try {
  mod = await import(pathToFileURL(patchedFile).href + "?t=" + Date.now());
} finally {
  try { rmSync(patchedFile, { force: true }); } catch {}
}

const { ensureMinterProfile, MINTER_PROFILE, MINTER_BUNDLES } = mod;
const profDir = path.join(HOME, "profiles", MINTER_PROFILE);

T("MINTER_PROFILE 是个独立名字，不叫 web", () => {
  if (MINTER_PROFILE !== "dsh-phone-minter") throw new Error(`实际 ${MINTER_PROFILE}`);
  if (MINTER_PROFILE === "web" || MINTER_PROFILE === "desktop") throw new Error("不能复用用户 profile");
});

T("MINTER_BUNDLES 只有 base + web-app", () => {
  const want = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
  if (JSON.stringify(MINTER_BUNDLES) !== JSON.stringify(want)) {
    throw new Error(`实际 ${JSON.stringify(MINTER_BUNDLES)}`);
  }
});

T("全新 DSH_HOME 能建出 4 个文件", () => {
  const r = ensureMinterProfile();
  if (!r.ok) throw new Error(r.message);
  for (const f of ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
    if (!existsSync(path.join(profDir, f))) throw new Error(`缺 ${f}`);
  }
});

T("package.json 的 bundles 正确", () => {
  const j = JSON.parse(readFileSync(path.join(profDir, "package.json"), "utf8"));
  const got = j.dsh.profile.bundles;
  if (JSON.stringify(got) !== JSON.stringify(MINTER_BUNDLES)) throw new Error(`实际 ${JSON.stringify(got)}`);
  if (j.dependencies && Object.keys(j.dependencies).length) throw new Error("dependencies 应该为空");
});

T("第二次调用幂等（changed=false，且不重写已有 patch 文件）", () => {
  const before = readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
  const r = ensureMinterProfile();
  if (!r.ok) throw new Error(r.message);
  if (r.changed) throw new Error(`不该有改动，实际改了 ${JSON.stringify(r.files)}`);
  const after = readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
  if (before !== after) throw new Error("patch 文件被改了");
});

T("用户自己在 patch 文件里加的东西不会被覆盖", () => {
  const f = path.join(profDir, "cordis.patch.yml");
  writeFileSync(f, "# 用户自己加的\n- id: something\n  disabled: true\n", "utf8");
  ensureMinterProfile();
  const t = readFileSync(f, "utf8");
  if (!t.includes("用户自己加的")) throw new Error("被覆盖了");
});

T("bundles 被塞进第三方 bundle 时会被纠正", () => {
  const f = path.join(profDir, "package.json");
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.dsh.profile.bundles.push("some-broken-plugin");
  writeFileSync(f, JSON.stringify(j, null, 2), "utf8");
  const r = ensureMinterProfile();
  if (!r.ok) throw new Error(r.message);
  if (!r.changed) throw new Error("应该报告 changed");
  const back = JSON.parse(readFileSync(f, "utf8"));
  if (JSON.stringify(back.dsh.profile.bundles) !== JSON.stringify(MINTER_BUNDLES)) {
    throw new Error(`没纠正回来：${JSON.stringify(back.dsh.profile.bundles)}`);
  }
});

T("package.json 坏成非 JSON 时会被重建", () => {
  const f = path.join(profDir, "package.json");
  writeFileSync(f, "{ 这不是 json", "utf8");
  const r = ensureMinterProfile();
  if (!r.ok) throw new Error(r.message);
  const back = JSON.parse(readFileSync(f, "utf8")); // 能 parse 就说明重建了
  if (JSON.stringify(back.dsh.profile.bundles) !== JSON.stringify(MINTER_BUNDLES)) {
    throw new Error("重建后 bundles 不对");
  }
});

T("根层 cordis.yml 是空数组", () => {
  const t = readFileSync(path.join(profDir, "cordis.yml"), "utf8");
  if (!/\[\]/.test(t)) throw new Error(`内容 ${JSON.stringify(t)}`);
});

T("pnpm-workspace.yaml 用 hoisted", () => {
  const t = readFileSync(path.join(profDir, "pnpm-workspace.yaml"), "utf8");
  if (!/nodeLinker:\s*hoisted/.test(t)) throw new Error(`内容 ${JSON.stringify(t)}`);
});

T("profile 目录建在 <DSH_HOME>/profiles/<name> 下", () => {
  if (!profDir.startsWith(HOME)) throw new Error(`${profDir} 不在 ${HOME} 里`);
  if (path.basename(path.dirname(profDir)) !== "profiles") throw new Error("父目录不是 profiles");
});

// 源码契约断言：这几处改动是"修好手机端"的关键，删了会静默退回到错误状态。
T("spawnMinter 用 --profile 而不是裸 web", () => {
  if (!/const args = \[\s*"--profile",\s*MINTER_PROFILE,/.test(src)) {
    throw new Error("没找到 `[\"--profile\", MINTER_PROFILE,`");
  }
  if (/"web",\s*"--host"/.test(src)) throw new Error("还留着把 web 当子命令的写法");
});

T("spawnMinter 把 DSH_PROFILE 钉成 MINTER_PROFILE", () => {
  if (!/env\.DSH_PROFILE = MINTER_PROFILE/.test(src)) throw new Error("没钉 DSH_PROFILE");
});

T("spawnMinter 会先 ensureMinterProfile()", () => {
  if (!/const prof = ensureMinterProfile\(\)/.test(src)) throw new Error("没调用 ensureMinterProfile");
});

T("状态快照带上 minterError / minterProfile", () => {
  if (!/minterError: minterError \|\| checkMinterLog\(\)/.test(src)) throw new Error("快照里没有 minterError");
  if (!/minterProfile: MINTER_PROFILE/.test(src)) throw new Error("快照里没有 minterProfile");
});

T("watch() 对 minter 有退避，不会每 30 秒白起进程", () => {
  if (!/minterRetryAt/.test(src)) throw new Error("没有 minterRetryAt");
  if (!/Date\.now\(\) >= minterRetryAt/.test(src)) throw new Error("没有检查退避时间");
});

T("重启桥接会清掉退避与上次错误", () => {
  const seg = src.slice(src.indexOf("restart: async () =>"), src.indexOf("restart: async () =>") + 900);
  if (!/minterRetryAt = 0/.test(seg) || !/minterError = ""/.test(seg)) {
    throw new Error("restart 里没清 minterError/minterRetryAt");
  }
});

rmSync(HOME, { recursive: true, force: true });

console.log(`\n${ok.length}/${ok.length + failed.length} 通过`);
if (failed.length) {
  console.log("失败：");
  for (const f of failed) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
