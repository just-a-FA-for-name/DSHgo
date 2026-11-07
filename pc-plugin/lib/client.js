window.__ModuleLoader__.load({
  id: "dsh-phone-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const NS = "phone-remote";     // settings 命名空间 / loader entry id
    const API = "/phone-remote";   // host 端路由前缀

    const React = require("react");
    const h = React.createElement;

    // ---- 样式 ---------------------------------------------------------
    // 尽量只用 dsw-alias-* 主题变量，跟随全局明暗主题自动变色。

    const CSS_ID = "dsh-phone-remote-ui";
    const CSS = `
.pr-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:720px}
.pr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.pr-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
.pr-dot{width:8px;height:8px;border-radius:50%;flex:none}
.pr-ok{background:#3ddc84}.pr-warn{background:#f5c542}.pr-bad{background:#ff5c5c}.pr-idle{background:var(--dsw-alias-label-secondary);opacity:.45}
.pr-rows{display:flex;flex-direction:column;gap:8px}
.pr-row{display:flex;align-items:baseline;gap:12px;line-height:1.6}
.pr-k{color:var(--dsw-alias-label-secondary);flex:none;min-width:6.5em;font-size:12px}
.pr-v{color:var(--dsw-alias-label-primary);word-break:break-all;font-size:12px;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}
.pr-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.pr-btn{font:inherit;font-size:12px;line-height:1;padding:7px 14px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);transition:border-color .15s,opacity .15s}
.pr-btn:hover:enabled{border-color:var(--dsw-alias-label-secondary)}
.pr-btn:disabled{opacity:.45;cursor:default}
.pr-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;font-weight:600}
.pr-link{color:var(--dsw-alias-brand-primary,#4d8dff);cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-size:12px;word-break:break-all}
.pr-note{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.65}
.pr-err{color:var(--dsw-alias-state-error-primary,#ff5c5c);font-size:12px;line-height:1.6;word-break:break-word}
.pr-peers{display:flex;flex-direction:column;gap:4px}
.pr-peer{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.pr-peer b{color:var(--dsw-alias-label-primary);font-weight:500}
.pr-copy{font:inherit;font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pr-copy:hover{color:var(--dsw-alias-label-primary)}
.pr-field{display:flex;align-items:center;gap:12px;justify-content:space-between}
.pr-field-label{display:flex;flex-direction:column;gap:2px;min-width:0}
.pr-field-title{font-size:12.5px;color:var(--dsw-alias-label-primary)}
.pr-field-desc{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.pr-input{font:inherit;font-size:12px;width:92px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-align:right;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace)}
.pr-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d8dff)}
.pr-switch{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;flex:none;transition:background .15s,border-color .15s;padding:0}
.pr-switch-on{background:var(--dsw-alias-button-primary-fill,#4d8dff);border-color:transparent}
.pr-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px #0003}
.pr-switch-on .pr-knob{transform:translateX(16px)}
.pr-sep{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.pr-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.pr-badge-ok{color:var(--dsw-alias-state-success-primary,#3ddc84);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3ddc84) 45%,transparent)}
.pr-account{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.pr-avatar{width:28px;height:28px;border-radius:50%;flex:none;object-fit:cover;border:1px solid var(--dsw-alias-border-l2)}
.pr-avatar-ph{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.pr-account-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.pr-account-name{font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr-account-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pr-btn-danger{color:var(--dsw-alias-state-error-primary,#ff5c5c);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff5c5c) 45%,transparent)}
.pr-btn-danger:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff5c5c) 12%,transparent)}
.pr-btn-confirm{background:var(--dsw-alias-state-error-primary,#ff5c5c);color:#fff;border-color:transparent;font-weight:600}
`.trim();

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return;
      const s = document.createElement("style");
      s.dataset.plugin = "dsh-phone-remote";
      s.dataset.pluginCss = CSS_ID;
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }

    // ---- host 通信 ----------------------------------------------------
    //
    // 桌面版前端跑在 file:// 下，绝对路径 "/phone-remote/..." 会打到
    // file:///phone-remote（必然失败）。用环境里能拿到的 HTTP 源拼；
    // 拿不到就退回相对路径（web 版下本来就在同源上）。
    function apiBase() {
      try {
        const env = (typeof globalThis !== "undefined" && globalThis.__DSH_ENV__) || {};
        const origin = env.origin || env.serverOrigin || "";
        if (origin && /^https?:/.test(origin)) return origin.replace(/\/$/, "") + API;
      } catch {}
      try {
        if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) {
          return API;
        }
      } catch {}
      // 桌面版：DSH 的 host 把 web 根跑在本地某个端口上，前端通过它取数据。
      // 拿不到就交给调用方兜底（下面会显示明确提示）。
      return API;
    }

    async function api(sub, method, payload) {
      const url = `${apiBase()}/${sub}`;
      const init = {
        method: method || "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      };
      if (payload !== undefined && payload !== null && init.method !== "GET") {
        init.headers["content-type"] = "application/json";
        init.body = typeof payload === "string" ? payload : JSON.stringify(payload);
      }
      const res = await fetch(url, init);
      let body = null;
      try { body = await res.json(); } catch {}
      if (!res.ok) throw new Error((body && body.message) || `HTTP ${res.status}`);
      return body || {};
    }

    // ---- 小组件 -------------------------------------------------------

    function Switch({ on, onChange, disabled }) {
      return h("button", {
        type: "button",
        className: "pr-switch" + (on ? " pr-switch-on" : ""),
        onClick: () => { if (!disabled) onChange(!on); },
        disabled,
        "aria-pressed": on ? "true" : "false",
      }, h("span", { className: "pr-knob" }));
    }

    function Field({ title, desc, children }) {
      return h("div", { className: "pr-field" },
        h("div", { className: "pr-field-label" },
          h("div", { className: "pr-field-title" }, title),
          desc ? h("div", { className: "pr-field-desc" }, desc) : null),
        children);
    }

    // ---- 主面板 -------------------------------------------------------

    function Panel() {
      const [st, setSt] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      const [msg, setMsg] = React.useState("");
      const [err, setErr] = React.useState("");
      const [ports, setPorts] = React.useState({ bridge: "", cli: "" });
      // 退出账号的二次确认：第一次点变成「确认退出」，5 秒内不点就自己收回。
      const [confirmOut, setConfirmOut] = React.useState(false);
      const alive = React.useRef(true);

      const armLogout = React.useCallback(() => {
        setConfirmOut(true);
        setMsg("");
        setErr("");
        window.setTimeout(() => { if (alive.current) setConfirmOut(false); }, 5000);
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const next = await api("state");
          if (!alive.current) return;
          setSt(next);
          setErr("");
          setPorts((p) => ({
            bridge: p.bridge || String((next.bridge || {}).port || ""),
            cli: p.cli || String((next.bridge || {}).cliPort || ""),
          }));
        } catch (e) {
          if (alive.current) setErr(String((e && e.message) || e));
        }
      }, []);

      React.useEffect(() => {
        alive.current = true;
        refresh();
        const t = setInterval(refresh, 5000);
        return () => { alive.current = false; clearInterval(t); };
      }, [refresh]);

      const act = React.useCallback(async (sub, label, body) => {
        setBusy(sub); setMsg(""); setErr("");
        try {
          const r = await api(sub, "POST", body);
          if (!alive.current) return;
          if (r.state) setSt(r.state);
          setMsg(r.message || (r.ok ? `${label}成功` : `${label}未完成`));
        } catch (e) {
          if (alive.current) setErr(String((e && e.message) || e));
        } finally {
          if (alive.current) { setBusy(""); refresh(); }
        }
      }, [refresh]);

      const copy = React.useCallback((text) => {
        try { navigator.clipboard.writeText(text); setMsg("已复制到剪贴板"); }
        catch { setMsg("复制失败，请手动选择文本"); }
      }, []);

      // 退出账号：两步。第一次点击只是把按钮切成危险色（armLogout），
      // 第二次才真的 POST /logout。这里必须带 confirm:true，后端也会拦一道。
      const doLogout = React.useCallback(async () => {
        setConfirmOut(false);
        setBusy("logout"); setMsg(""); setErr("");
        try {
          const r = await api("logout", "POST", { confirm: true });
          if (!alive.current) return;
          if (r.state) setSt(r.state);
          setMsg(r.message || (r.ok ? "已退出账号" : "退出未完成"));
        } catch (e) {
          if (alive.current) setErr(String((e && e.message) || e));
        } finally {
          if (alive.current) { setBusy(""); refresh(); }
        }
      }, [refresh]);

      if (err && !st) {
        return h("div", { className: "pr-wrap" },
          h("div", { className: "pr-card" },
            h("div", { className: "pr-head" }, "手机远程（DSHgo）"),
            h("div", { className: "pr-err" }, "读取状态失败：" + err),
            h("div", { className: "pr-note" },
              "如果一直失败，说明插件后端路由未挂载。检查 ~/.dsh/logs/ 下的日志。"),
            h("div", { className: "pr-actions" },
              h("button", { className: "pr-btn", onClick: refresh }, "重试"))));
      }

      if (!st) {
        return h("div", { className: "pr-wrap" },
          h("div", { className: "pr-card" },
            h("div", { className: "pr-head" }, "手机远程（DSHgo）"),
            h("div", { className: "pr-note" }, "正在读取状态…")));
      }

      const ts = st.tailscale || {};
      const sv = st.serve || {};
      const br = st.bridge || {};
      const running = ts.backendState === "Running";
      const acct = ts.account || {};
      const loggedIn = !!acct.loggedIn;

      const dot = !ts.reachable ? "pr-bad" : running ? "pr-ok" : "pr-warn";
      const stateText = !ts.reachable ? "Tailscale 未运行"
        : running ? "已连接"
        : ts.backendState === "NeedsLogin" ? "需要登录"
        : ts.backendState === "Stopped" ? "已停止"
        : (ts.backendState || "未知");

      const url = ts.dnsName ? `https://${ts.dnsName}/` : "";
      const peers = ts.peers || [];
      const onlinePeers = peers.filter((p) => p.online);

      const row = (k, v) => h("div", { className: "pr-row", key: k },
        h("span", { className: "pr-k" }, k),
        h("span", { className: "pr-v" }, v));

      // 账号行：头像 + 登录名 + tailnet 名。退出账号后 tailscale 会把 User
      // 清空，这里就退化成占位符，别让它显示成空白让用户以为面板坏了。
      const accountRow = h("div", { className: "pr-account" },
        acct.avatarUrl
          ? h("img", { className: "pr-avatar", src: acct.avatarUrl, alt: "", referrerPolicy: "no-referrer" })
          : h("div", { className: "pr-avatar-ph" }, loggedIn ? "?" : "—"),
        h("div", { className: "pr-account-main" },
          h("div", { className: "pr-account-name" },
            loggedIn
              ? (acct.displayName || acct.loginName || "已登录")
              : (ts.reachable ? "未登录 Tailscale" : "账号未知")),
          h("div", { className: "pr-account-sub" },
            loggedIn
              ? [acct.loginName, acct.tailnetName].filter(Boolean).join(" · ")
              : (st.loggedOut ? "已退出账号，点「连接」可重新授权" : "尚无账号信息"))),
        loggedIn
          ? h("span", { className: "pr-badge pr-badge-ok" }, "已登录")
          : h("span", { className: "pr-badge" }, "未登录"));

      return h("div", { className: "pr-wrap" },

        // ===== 状态 =====
        h("div", { className: "pr-card" },
          h("div", { className: "pr-head" },
            h("i", { className: "pr-dot " + dot }),
            "状态 · " + stateText,
            sv.configured ? h("span", { className: "pr-badge pr-badge-ok" }, "已发布") : null),

          h("div", { className: "pr-rows" },
            accountRow,
            url ? h("div", { className: "pr-row", key: "url" },
              h("span", { className: "pr-k" }, "手机访问地址"),
              h("span", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                h("span", { className: "pr-v" }, url),
                h("button", { className: "pr-copy", onClick: () => copy(url) }, "复制")))
              : row("手机访问地址", "（未登录，暂无地址）"),
            row("本机 Tailnet IP", (ts.ips && ts.ips.length) ? ts.ips[0] : "—"),
            row("主机名", ts.hostname || "—"),
            row("桥接端口", `${br.port != null ? br.port : "—"} ${br.alive ? "· 运行中" : "· 未运行"}`),
            row("登录签发端口", `${br.cliPort != null ? br.cliPort : "—"} ${br.minterAlive ? "· 运行中" : "· 未运行"}`),
            row("Tailnet 发布", sv.configured ? `已发布 → :${sv.port}` : "未发布")),

          ts.error ? h("div", { className: "pr-err" }, "Tailscale 错误：" + ts.error) : null,
          st.lastError ? h("div", { className: "pr-err" }, "上次操作失败：" + st.lastError) : null,

          // 登录签发（minter）挂了。这是手机端卡在「正在等待电脑上的 DSH 桌面
          // App…」的直接原因：没有它就没有 cookie，bridge 永远找不到桌面 App
          // 的 web 根。以前这条信息只写在 ~/.dsh/logs/dsh-web-serve.log 里，
          // 面板只显示一句「未运行」，用户没有任何线索。现在直接把 dsh 自己的
          // 失败摘要摆出来，并指明「重启桥接」可以重拉。
          !br.minterAlive && br.minterError
            ? h("div", { className: "pr-err" },
              "登录签发实例启动失败：" + br.minterError,
              br.minterProfile ? `（profile ${br.minterProfile}）` : "")
            : null,
          !br.minterAlive && !br.minterError
            ? h("div", { className: "pr-note" },
              "登录签发实例未运行 —— 手机打开会一直停在「正在等待电脑上的 DSH 桌面 App…」。",
              "点下面的「重启桥接」重新拉起它。")
            : null,

          st.loggedOut && !loggedIn ? h("div", { className: "pr-note" },
            "已退出 Tailscale 账号。点「连接」会在浏览器里重新授权；想换账号就在那一步用别的账号登录。",
            st.paused ? "（自动重连已挂起，不会被插件自己接回去。）" : "") : null,

          ts.authUrl ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { className: "pr-note" }, "需要在浏览器里授权一次（打开后点 Connect device）："),
            h("a", { className: "pr-link", href: ts.authUrl, target: "_blank", rel: "noreferrer" }, ts.authUrl),
            h("div", {},
              h("button", { className: "pr-copy", onClick: () => copy(ts.authUrl) }, "复制链接"))) : null,

          // Serve 未启用时的批准入口。tailscale serve 只把这条链接打到 stdout，
          // 不接住的话用户就只剩一句「需要先批准 Serve」能动。
          !sv.configured && sv.approveUrl ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { className: "pr-note" },
              "这个 tailnet 还没启用 Serve，需要先批准一次（只需一次，之后一直有效）："),
            h("a", { className: "pr-link", href: sv.approveUrl, target: "_blank", rel: "noreferrer" }, sv.approveUrl),
            h("div", {},
              h("button", { className: "pr-copy", onClick: () => copy(sv.approveUrl) }, "复制链接"),
              h("button", { className: "pr-copy", style: { marginLeft: 8 }, onClick: () => act("serve", "发布") }, "我已批准，重试"))) : null,

          // 没批准链接、但 serve 也不通 —— 多半是换 tailnet 后 HTTPS 证书没开。
          !sv.configured && !sv.approveUrl && sv.hint === "https"
            ? h("div", { className: "pr-note" },
              "tailnet 还没开启 HTTPS 证书。去 ", 
              h("a", { className: "pr-link", href: "https://login.tailscale.com/admin/dns", target: "_blank", rel: "noreferrer" },
                "admin/dns"),
              " 把 HTTPS Certificates 打开，然后回来点「发布」。") : null,

          h("div", { className: "pr-actions" },
            h("button", {
              className: "pr-btn pr-btn-primary",
              disabled: !!busy || running,
              onClick: () => act("up", "连接"),
            }, busy === "up" ? "连接中…" : (running ? "已连接" : "连接")),
            h("button", {
              className: "pr-btn",
              disabled: !!busy || !running,
              onClick: () => act("down", "断开"),
            }, busy === "down" ? "断开中…" : "断开"),
            h("button", {
              className: "pr-btn",
              disabled: !!busy || !running || !!sv.configured,
              onClick: () => act("serve", "发布"),
            }, busy === "serve" ? "发布中…" : (sv.configured ? "已发布" : "发布到 Tailnet")),
            h("button", {
              className: "pr-btn",
              disabled: !!busy,
              onClick: () => act("restart", "重启"),
            }, busy === "restart" ? "重启中…" : "重启桥接"),
            h("button", { className: "pr-btn", disabled: !!busy, onClick: refresh }, "刷新"),
            // 退出账号：两步确认。没登录时禁用 —— 没有账号可退。
            h("button", {
              className: "pr-btn " + (confirmOut ? "pr-btn-confirm" : "pr-btn-danger"),
              disabled: !!busy || !loggedIn,
              onClick: confirmOut ? doLogout : armLogout,
              title: loggedIn
                ? "作废本机 node key，之后需要重新授权（可在授权页换账号）"
                : "当前未登录",
            }, busy === "logout" ? "退出中…" : (confirmOut ? "确认退出账号？" : "退出账号"))),

          confirmOut ? h("div", { className: "pr-note" },
            "确认后会执行 tailscale logout：本机授权作废，手机端会立即断连，",
            "之后需要重新在浏览器里授权才能连回来（5 秒内不点会自动取消）。") : null),

        msg ? h("div", { className: "pr-card", style: { padding: "10px 16px" } },
          h("div", { className: "pr-note" }, msg)) : null,

        // ===== 设置项 =====
        h("div", { className: "pr-card" },
          h("div", { className: "pr-head" }, "设置"),

          h(Field, {
            title: "自动接管 Tailscale",
            desc: "打开 DSH 时若 Tailscale 未连接，自动把它拉起来",
          }, h(Switch, {
            on: st.settings ? !!st.settings.autoTailscale : true,
            disabled: !!busy,
            onChange: (v) => act("config", "保存", { autoTailscale: v }),
          })),

          h("div", { className: "pr-sep" }),

          h(Field, {
            title: "自动发布到 Tailnet",
            desc: "隧道就绪后自动执行 tailscale serve，把桥接端口暴露给手机",
          }, h(Switch, {
            on: st.settings ? !!st.settings.serve : true,
            disabled: !!busy,
            onChange: (v) => act("config", "保存", { serve: v }),
          })),

          h("div", { className: "pr-sep" }),

          h(Field, {
            title: "退出 DSH 时断开隧道",
            desc: "默认关闭。手机端隧道引擎没有自动重连，一旦断开就要拿起手机重开 App 才能恢复",
          }, h(Switch, {
            on: st.settings ? !!st.settings.stopOnExit : false,
            disabled: !!busy,
            onChange: (v) => act("config", "保存", { stopOnExit: v }),
          })),

          h("div", { className: "pr-sep" }),

          h(Field, {
            title: "桥接端口",
            desc: "手机流量入口，默认 8124。改完需重启 DSH 生效。",
          }, h("input", {
            className: "pr-input",
            value: ports.bridge,
            inputMode: "numeric",
            onChange: (e) => setPorts((p) => ({ ...p, bridge: e.target.value.replace(/\D/g, "") })),
            onBlur: () => {
              const n = Number(ports.bridge);
              const cur = (st.bridge || {}).port;
              if (n >= 1024 && n <= 65535 && n !== cur) act("config", "保存", { bridgePort: n });
              else if (n !== cur) setPorts((p) => ({ ...p, bridge: String(cur) }));
            },
          })),

          h("div", { className: "pr-sep" }),

          h(Field, {
            title: "登录签发端口",
            desc: "内部 dsh web 实例，用于签发登录 cookie。默认 8090。",
          }, h("input", {
            className: "pr-input",
            value: ports.cli,
            inputMode: "numeric",
            onChange: (e) => setPorts((p) => ({ ...p, cli: e.target.value.replace(/\D/g, "") })),
            onBlur: () => {
              const n = Number(ports.cli);
              const cur = (st.bridge || {}).cliPort;
              if (n >= 1024 && n <= 65535 && n !== cur) act("config", "保存", { cliPort: n });
              else if (n !== cur) setPorts((p) => ({ ...p, cli: String(cur) }));
            },
          }))),

        // ===== 设备 =====
        peers.length ? h("div", { className: "pr-card" },
          h("div", { className: "pr-head" }, `Tailnet 设备（${onlinePeers.length}/${peers.length} 在线）`),
          h("div", { className: "pr-peers" },
            peers.map((p) => h("div", { className: "pr-peer", key: (p.dns || p.name) + p.os },
              h("i", { className: "pr-dot " + (p.online ? "pr-ok" : "pr-idle") }),
              h("b", {}, p.name || p.dns || "?"),
              h("span", {}, p.os || ""),
              p.online ? null : h("span", {}, "· 离线"))))) : null,

        // ===== 说明 =====
        h("div", { className: "pr-card" },
          h("div", { className: "pr-note" },
            "插件会自动守护整条链路：DSH 启动时若 Tailscale 未连接会自动拉起，",
            "隧道就绪后自动把桥接端口发布到 tailnet。",
            "手机端安装 DSHgo App 后打开即可连接，无需手动启动 Tailscale。")));
    }

    // ---- 插件入口 -----------------------------------------------------
    //
    // 挂载点：`settings.section` —— 「设置」左侧导航栏里的一级条目，
    // 和 Better Display / 自动签到 / 通知提醒 同一级。
    //
    // 踩过的坑（免得再走回头路）：
    //   · `plugins.bundle.config` 只由「插件管理」页渲染，而本机 profile 把
    //     web-ui-plugin-manager 设成 disabled: true，往那儿注册等于看不见。
    //   · `settings.plugins.tab` 能让条目出现在「内置插件」页的标签栏里，
    //     但那是二级 tab，不是侧边栏一级入口。
    function apply(ctx) {
      ensureCss();

      ctx.effect(() => ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: NS,
          order: 46,
          label: () => "手机远程",
        }, () => h(Panel))), "dsh-phone-remote: settings section");
    }

    module.exports = {
      name: NS,
      inject: ["slots"],
      apply,
    };
    return module.exports;
  },
});
