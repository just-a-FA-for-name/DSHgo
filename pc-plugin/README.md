# dsh-phone-remote V1.3

DSHgo 的电脑端桥接插件。负责把手机请求交给电脑上运行的 dsh 工作台，维持页面/实时连接、登录转接和本地端口穿透。

V1.3 修复桌面 CLI 路径自动发现、Serve 失败重复等待，以及 WebView 页面启动兼容性。完整边界见仓库 docs/V1.3验收记录.md。

已有 DSH 任务运行时先不要重启。桥接页面修复可以单独重启桥接生效；CLI 路径与 Serve 退避需要重新加载完整插件，在任务结束后重启桌面端。

## 从 V1.1 / V1.2 升级到 V1.3

1. 使用配套的 `DSHgo-pc-plugin-v1.3.zip`，完整解压。
2. 打开 `pc-plugin` 文件夹，双击 `install.bat`，覆盖更新原有插件。
3. 退出并重新打开 dsh 桌面版。
4. 手机覆盖安装配套 `DSHgo-v1.3.apk`。

原有 Tailscale 安装与账号继续使用，无须额外安装第二套远程工具。若使用自定义配置，请保留并检查配置。

## 为什么必须升级电脑插件

V1.2 的文件续传需要电脑端提供分块暂存、已确认偏移和最终回执接口；旧插件没有这些能力。新版还修复端口发现、桥接缓存、实时流与 WebSocket 转发问题，并在工作台启动前装载新版手机传输逻辑。

只更新手机 APK 仍能获得手机端 DNS/应用专用 VPN 修复，但要获得完整文件续传和桥接修复，需要两端一起升级。

- 分块 32 KiB–1 MiB 自适应，从 128 KiB 开始；不重复执行消息/最终提交。
- 电脑临时文件流式落盘，网络断开可继续；App/WebView 被杀、桥接重启后需要重新选择文件。
- 单文件协议上限 2 GiB（尚未实测该大小）；最多 8 个暂存上传、总额度 4 GiB。
- 运行时清理 30 分钟无活动暂存；异常退出的临时目录不保证自动回收。
- 图片保持 DSH 原有图片消息协议，不能把分块续传视作所有图片问题已解决。

## 首次安装

先安装 [Tailscale](https://tailscale.com/) 并登录与手机相同的 tailnet，再双击 `install.bat`，完成后重启 dsh。

| 组件 | 作用 |
|---|---|
| minter | dsh web 子进程，签发登录 Cookie |
| bridge | 默认 8124，转发页面、文件、实时连接和本地端口请求 |
| serve | 用 tailscale serve 发布到自己的 tailnet |

安装脚本更新 `~/.dsh/bundles/dsh-phone-remote` 并注册到已有 dsh profile。重复安装不会产生 lib/lib 或 bridge/bridge。

配置见 `cordis.patch.yml` 中 phone-remote 条目。卸载时从 profile 的 package.json 移除 dsh-phone-remote 依赖，并移除对应配置，再重启 dsh。

完整更新与测试限制见 [V1.3 发布说明](https://github.com/just-a-FA-for-name/DSHgo/releases/tag/v1.3)。
