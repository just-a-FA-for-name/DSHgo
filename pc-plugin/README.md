# dsh-phone-remote（增强版）

DSHgo 手机远程的 PC 端。**只开 dsh 就行**：插件会把 Tailscale 隧道、登录 cookie、
手机流量桥接一起拉起来并持续守护。

原版要求你先手动打开 Tailscale 并保持运行；本版把 Tailscale 也纳入托管。

---

## 它做了什么

dsh 一启动，插件进入 30 秒一轮的看门狗循环：

| 环节 | 行为 |
| --- | --- |
| `tailscaled` | 守护进程不可达时尝试 `sc start Tailscale` |
| `tailscale up` | 隧道没通（`Stopped` / `NoState` / `WantRunning=false`）时自动拉起 |
| 登录 | 首次需要登录时，把登录链接写进 `~/.dsh/logs/dsh-phone-remote-login.txt`；配了 `authKey` 则全自动 |
| `serve` | 隧道通了以后自动 `tailscale serve --bg 8124`，幂等；失败按 60 秒退避重试 |
| `minter` | 起 `dsh --profile dsh-phone-minter` 子进程签发登录 token |
| `bridge` | 起 `bridge/dsh-phone-proxy.cjs`，手机的流量入口 |

登录状态由 Tailscale 自己持久化。**登录过这一次之后，以后开 dsh 隧道就自动就绪，
不需要再碰 Tailscale。**

---

## 退出当前账号

设置页「手机远程」面板的账号行会显示当前登录的 Tailscale 账号（头像 / 登录名 /
tailnet），右边有 **退出账号** 按钮。它执行的是 `tailscale logout`，不是
`tailscale down` —— 两者区别很大：

| | `down` | `logout` |
| --- | --- | --- |
| 隧道 | 关掉 | 关掉 |
| 本机 node key | 保留 | **作废** |
| 下次 `up` | 直接连回来，秒级 | 必须在浏览器里重新授权 |
| 换账号 | 不行 | 可以（在授权页用别的账号登录） |

所以按钮做了两步确认：第一次点变成「确认退出账号？」，5 秒内再点才真的执行。
执行后插件会做三件事：

1. 收掉 `bridge` 与 `minter` 子进程 —— 隧道没了它们没有意义；
2. **挂起自动连接**（`tsPaused`），否则 30 秒后的下一轮看门狗又会 `tailscale up`，
   配了 `authKey` 时甚至会拿同一把密钥把刚退出的账号登回去；
3. 在面板上说明「已退出账号，点『连接』可重新授权」。

点「连接」= 表达"我确实想连"，会解除挂起、重新走授权流程（那一步正好可以换账号）。
挂起状态只在本次 dsh 进程内有效；重启 dsh 后 `autoUp` 恢复正常。

相关接口：`POST /phone-remote/logout`，body 必须带 `{"confirm": true}`，否则只返回
`needConfirm` 提示、不碰 Tailscale。返回体里附 `account`（被退出的账号）与
`remaining`（退出后的账号状态），便于核对。

---

## 登录签发实例（minter）

手机端拿到的 cookie 是 minter 签发的，所以 minter 必须活着。它跑的是**插件自己维护**
的 profile：

```
~/.dsh/profiles/dsh-phone-minter/     # 命令：dsh --profile dsh-phone-minter --port 8090 --no-open
├── package.json                      # bundles 只挂 dsh-base + dsh-web-app
├── cordis.patch.yml                  # []
├── cordis.yml                        # []
└── pnpm-workspace.yaml               # nodeLinker: hoisted
```

为什么不复用你的 `web`：那个 profile 里会累积第三方 bundle 和 `disabled: true`
条目（尤其是 `system-prompt`），一旦被禁，`dsh` 必然报
`startup failed: 2 required plugins did not activate`，token 就签发不出来，手机端
只能看到等待页。插件每次启动都会核对这份 profile 的 `bundles`，缺文件就补、
被塞了别的 bundle 就改回来；你自己的 `cordis.patch.yml` 不会被它动。

它必须用同一个 `DSH_HOME`（默认 `~/.dsh`）—— cookie 的签名域跟着 DSH_HOME 走，
换一个 home 签出来的 cookie 打桌面 App 的端口只会得到 401。

---

## 配置

写在各 profile 的 `cordis.patch.yml` 里：

```yaml
- id: phone-remote
  name: "dsh-phone-remote"
  config:
    bridgePort: 8124        # 手机流量入口
    cliPort: 8090           # 签发登录 cookie 的 dsh 实例（插件自建的 dsh-phone-minter profile）
    minter: true            # 自己已跑 dsh web 时可关
    trustedHost: ""         # 透传 dsh web --trusted-host
    serve: true             # 自己管 tailscale serve 时可关
    dshBin: ""              # 留空自动探测
    tailscaleBin: ""        # 留空自动探测
    tailscale:
      enabled: true         # false = 完全不碰 Tailscale，只跑 bridge/minter
      autoUp: true          # 未连接时自动 tailscale up
      autoLogin: true       # 需要登录时写出登录链接
      openLoginBrowser: false   # 顺手打开浏览器登录页
      authKey: ""           # tskey-auth-…，填了就完全免手动登录
      serveRetryMs: 60000
      upTimeoutMs: 25000
```

### 想完全免手动登录（推荐）

在 https://login.tailscale.com/admin/settings/keys 生成一个 **Reusable + Pre-approved**
的 auth key，写进 `tailscale.authKey`（或用环境变量 `DSH_PHONE_TS_AUTHKEY`）。
之后重装系统也不必再点登录。

> auth key 等同凭据，别提交到公开仓库。

### 前置条件

`tailscale serve` 需要两个**只由 tailnet 管理员在网页上**打开的开关。换过账号之后
这两项都是关闭的，`serve` 会一直失败：

1. **启用 Serve**。没开时 `tailscale serve` 只往 stdout 打一句
   `Serve is not enabled on your tailnet.` 和一条
   `https://login.tailscale.com/f/serve?node=<节点ID>`。插件会把这条链接抓出来
   显示在面板上（也写进 `dsh-phone-remote-serve.txt`），点一次即可，之后永久有效。
   链接里的 `<节点ID>` 就是 `tailscale status --json` 的 `Self.ID`。
2. **HTTPS Certificates**：https://login.tailscale.com/admin/dns → 打开
   **HTTPS Certificates**。不开的话 `tailscale cert` 会报
   `your Tailscale account does not support getting TLS certs`，`status --json`
   的 `CertDomains` 也会是空的。

两个都开好之后，面板点「发布到 Tailnet」，`serve status --json` 里就会出现
`127.0.0.1:<bridgePort>`，手机访问 `https://<节点名>.<tailnet>.ts.net/`。

---

## 排查

日志都在 `~/.dsh/logs/`：

| 文件 | 内容 |
| --- | --- |
| `dsh-phone-remote-status.json` | 当前隧道状态 / IP / 端口 / 子进程存活，最有用的一个 |
| `dsh-phone-remote-login.txt` | 需要登录时的登录链接（30 分钟内有效，过期视为不存在） |
| `dsh-phone-remote-serve.txt` | tailnet 未启用 Serve 时的批准链接 |
| `dsh-phone-remote.log` | bridge 的 stdout/stderr |
| `dsh-web-serve.log` | minter 输出（含 `dsh web: http://…?token=…`）；起不来的原因也记在这里 |

常见情况：

- **`backendState: NeedsLogin`** → 用面板上那条链接登录一次（30 分钟后会重新取）
- **`serve` 报「需要先批准 Serve」** → 点面板上出现的批准链接，一次即可
- **`serve` 报 HTTPS 未开启** → 去 admin/dns 打开 HTTPS Certificates
- **`bridgeAlive: false`** → 看 `dsh-phone-remote.log`
- **`minterAlive: false` / 面板提示「登录签发实例启动失败」** → 看 `dsh-web-serve.log`
  与状态快照里的 `minterError`。插件会自己重建 `~/.dsh/profiles/dsh-phone-minter`
  这个干净 profile（只挂 `dsh-base` + `dsh-web-app`），失败后按 30 秒起指数退避，
  最长 5 分钟一次；点「重启桥接」可立即清掉退避重试
- **手机打开一直停在「正在等待电脑上的 DSH 桌面 App…」** → 就是 minter 没起来
  （没有 token，bridge 探不到应用端口，退化到 4505）→ 同上，看 `minterError`
- **手机连不上但状态全绿** → 手机端确认登的是同一个 tailnet 账号

---

## 卸载

从各 profile 的 `package.json` 里删掉 `dsh-phone-remote` 依赖与 `dsh.profile.bundles`
里的 `dsh-phone-remote`，然后删掉 `~/.dsh/bundles/dsh-phone-remote`。

---

## 与原版的差别

| | 原版 v1.1 | 本版 v1.5 |
| --- | --- | --- |
| Tailscale 需手动开 | 是 | 否，插件托管 |
| 未连接自动 up | 否 | 是 |
| 登录链接提示 | 无 | 写文件 + 日志 |
| authKey 免登录 | 无 | 支持 |
| serve 幂等/退避 | 一次性，失败不重试 | 有退避重试 |
| `.cmd` 含空格路径 | 会失败（`dsh` 不在 PATH 时 minter 起不来） | 已修 |
| dshBin 自动探测 | 无（默认裸 `dsh`） | 有 |
| 状态快照 | 无 | `dsh-phone-remote-status.json` |
| 退出当前账号 | 无 | 设置页按钮（`tailscale logout`，带二次确认与自动连接挂起） |
| Serve 未启用 | 只报「需要批准」 | 面板直接给出批准链接 + 一键重试 |
| 登录链接 | 写一次文件，过期后回退成死链（404） | 只认 30 分钟内的，且链接稳定不变 |
| minter 用哪个 profile | 用户的 `web`（会被第三方插件改坏） | 自建 `dsh-phone-minter`，每次核对并修复 |
| minter 起不来 | 只在日志里，面板看不出来 | `minterError` + 面板红字 + 指数退避 + 「重启桥接」清零 |

---

## 与 `main` 分支（V1.3）的关系

这份代码不是 `main` 上 `pc-plugin` 的后继，而是**另一条血统**：本机在跑的「增强版」
从 V1.1 起独立演进（把 Tailscale 也纳入托管、加了设置页面板），而 `main` 在
V1.2 / V1.3 走的是另一条路（文件分块续传 + 手机端传输注入 + `install.bat` 安装器）。

两侧逐项对照（实测读源码得出，不是推断）：

| 能力 | `main`（V1.3） | 本分支（V1.5 增强版） |
| --- | --- | --- |
| `/__dsh/uploads` 分块续传 | 有（`bridge/resumable-upload.cjs`） | **没有** |
| `/__dsh/transport.js` 注入 | 有（`bridge/transport.js`） | **没有** |
| `install.bat` / `install.ps1` | 有 | 无（本机是 pnpm link 安装） |
| Tailscale 托管 / 自动 `up` / serve 退避 | 无 | 有 |
| 设置页面板（状态 / 退出账号 / 发布按钮） | 无 | 有 |
| `lib/runtime.js` | 有（`resolveDshBin` / `serveRetryDelay`） | 无（逻辑在 `lib/index.js` 内） |
| app 端口探测 | 直接扫端口 | 扫端口 + 用 minter 的 cookie 探 `__DSH_BOOT__` 打分，避开 SnowLuma 之类的旁路 web 根 |

`bridge/transport.js`、`bridge/resumable-upload.cjs`、`lib/runtime.js`、`install.bat`、
`install.ps1` 都**保留在树里**没有被删；但本分支的 `bridge/dsh-phone-proxy.cjs` 没有
调用它们。要不要把续传与传输注入接回这条血统，需要先决定——在真机上验证过上传之前
不建议直接合进 `main`。
