# DSHgo

**把 DeepSeek Harness (dsh) 的工作台装进口袋。** 点开手机 App 就是电脑上正在跑的实时会话——可看、可操作、可语音。

手机端一个 APK（Tailscale 隧道内核内置），PC 端一个 dsh 插件 + Tailscale，开包即用。

- 作者：**Fa2517**（[bilibili](https://space.bilibili.com/330037645)）
- 版本：v1.3 · 本项目完全开源 · [更新日志](CHANGELOG.md)
- **有任何问题，欢迎在 B 站视频下方留言交流** → [@Fa2517](https://space.bilibili.com/330037645)；GitHub Issues 也行，但最好在 B 站知会一声

## 功能

| | |
|---|---|
| 🔒 内置加密隧道 | Tailscale 内核编译进 APK，App 内登录建隧道，装一个 App 就够 |
| 🎯 应用专用隧道 | 只允许 DSHgo 使用 VPN，显式下发 MagicDNS，其他应用保持原有网络 |
| 🧭 万能抓取 | 隧道接通后自动识别远程工作台并直连，不挑主机名/端口 |
| 👀 实时监控 | 电脑上正在跑的会话、子智能体、后台任务，手机实时可见可操作 |
| 🎨 DSHgo / ZCode go 双模式 | 顶栏一键切换；切 ZCode 自动关隧道、切回自动开 |
| 🪟 站点小窗 | 悬浮窗查看本地监控页（默认关闭，可选开关）；页面里的 127.0.0.1 请求自动穿隧道回电脑 |
| 🎤 语音输入 | 麦克风权限自动申请，开箱即用 |
| 🌗 弱网优化 | 连接状态提示、加载失败退避重试、实时流式转发 |
| 📎 手机上传文件 | 系统选择器、多选、分块进度和网络中断后继续上传；从「＋ → 文件」添加 |
| ☰ 手机抽屉导航 | 侧边栏默认收起，顶栏图标展开，选会话/点遮罩/返回键收起 |
| 🐟 可选大肥鱼主题 | 顶部连接徽章、侧栏与输入卡片、连接/错误插画；设置中随时切换，保留当前页面 |
| 🧾 免 root 诊断 | 有界本地状态日志，手动导出 ZIP；支持关闭和清除，不采集聊天或连接地址 |
| 🎞 开机动画 | 右往左拉出；哔哩哔哩与 FA 2517 同组出现，浅色渐变背景 |

> V1.2 在 SM-F7310 上验证了约 32 MiB 文件回执和合成 PNG 图片加载；尚不能保证所有图片来源和设备。文件断点恢复需要同时更新电脑插件；App / 桥接进程重启后需重新选择文件。详细测试范围见 [验收记录](docs/V1.2验收记录.md)。

## 安装

**PC 端（一次性）**
1. 安装 [Tailscale](https://tailscale.com/) 并登录（与手机同账号）
2. 安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh 桌面版）
3. 进入 `pc-plugin/` 双击 `install.bat`，重启 dsh

**手机端**
1. 安装 `DSHgo-v1.3.apk`（[Releases](../../releases) 下载）
2. 打开 → 登录 Tailscale（仅此一次）→ 允许 VPN / 麦克风授权

更新到 v1.3：手机覆盖安装（保留原签名），电脑端重新运行插件安装脚本并重启 dsh。两端需要同时更新，具体原因与操作见 [V1.3 发布说明](docs/RELEASE-v1.3.md)。

之后每次打开 App 自动：建隧道 → 发现电脑 → 进入工作台。

详细文档见 [`docs/使用说明.md`](docs/使用说明.md)。

## 仓库结构

```
phone-app/    Android 端源码（无 Gradle，build.bat 一键打包）
pc-plugin/    PC 端 dsh 插件（install.bat 一键安装，dsh 启动即用）
docs/         使用说明
```

## 从源码构建手机端

```bat
cd phone-app
copy build-env.example.bat build-env.bat   :: 填入本机 JDK / Android SDK / libtailscale.aar 路径
build.bat
```

- 需要：JDK 17、Android SDK（build-tools 34、platform 34）
- libtailscale.aar：用 [tailscale-android](https://github.com/tailscale/tailscale-android) 源码经 gomobile bind 产出
- 签名密钥首次构建自动生成（`build/dsh.keystore`），勿提交到任何仓库

## 设计说明

- **PC 插件零 dsh 内部依赖**：只用 `apply(ctx, config)` 插件形态 + node 内置模块
  监督外部进程（`dsh web` 登录签发 + 桥接 + `tailscale serve`），dsh 版本升级不影响插件
- **桥接自愈**：端口被占用自动让位、进程挂掉 30 秒内重启；App 的 web 端口每回启动
  用 cookie 实测自动挑选（同进程可能托管多个 web 根）
- **本地端口穿透**：串流到手机的本地页面里的 `127.0.0.1:*` 请求自动代理回电脑，
  任何本地监控面板无需改动即可在手机使用

## 隐私

- 全程 Tailscale（WireGuard）加密隧道，仅自己设备可达
- 凭据经 Android Keystore 加密存储，不出设备
- App 不收集、不上传任何个人信息

## 特别鸣谢

特别鸣谢我的朋友 **catnaut**！

感谢他提供一天“爽吃 Astra”的套餐，帮助我快速完成这个项目。非常感谢！

## License

[MIT](LICENSE) · Made with ❤ by [Fa2517](https://space.bilibili.com/330037645)
· **有问题视频下方聊，B 站见！**

## 诊断与主题

手机设置 → 故障排查 → 本地诊断日志（默认开启）。在真实 5G 复现后，点击「导出诊断包」，选择保存位置，将 ZIP 与复现时间、操作一起反馈。无须 root、ADB 或 READ_LOGS 权限；不自动发送。日志只含数字状态事件，约 768 KiB 循环保存，不含聊天、文件名、IP、域名、Cookie、Token 或系统日志。可关闭记录、手动清除。

设置 → 显示 → 主题风格 →「大肥鱼 · 海盐蓝」。保留原有五种主题，切换只更新当前界面颜色与装饰，不重建 WebView。仍按手机竖屏触控适配。

代码沿用 MIT 许可；新增大肥鱼插画独立遵循 [素材署名与许可](phone-app/ASSET-LICENSES.md)，不能将图片视为 MIT 素材。
