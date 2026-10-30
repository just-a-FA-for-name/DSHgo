package com.dsh.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JsResult;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * DSH mobile client. The Tailscale engine runs inside this process and the
 * tunnel is established by our own VpnService; the remote workbench is web
 * tech underneath, but the shell behaves and looks like a native app.
 */
public class MainActivity extends Activity {

    private static final String UA_DESKTOP =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

    private static final int REQ_VPN = 1001;
    private static final int REQ_FILES = 1003;
    private android.webkit.ValueCallback<Uri[]> fileChooser;
    private String mobileUiScript;

    private static final int ST_NEED_LOGIN = 0;
    private static final int ST_NEED_VPN = 1;
    private static final int ST_TUNNEL = 2;
    private static final int ST_DISCOVER = 3;
    private static final int ST_CONNECTING = 4;
    private static final int ST_READY = 5;
    private static final int ST_ERROR = 6;

    private int BG, BAR, TEXT, DIM, ACCENT;

    private WebView web;
    private FrameLayout stack;
    private LinearLayout overlay, mainRoot, toolbar;
    private ImageView stateArt, statusFish;
    private LinearLayout connectionBadge;
    private FrameLayout loginLayer;
    private WebView loginWeb;
    private TextView statusTitle, statusSub, subtitleView;
    private Button actionBtn;
    private View dot;
    private ProgressBar topBar;
    private int state = ST_CONNECTING;
    private boolean pageEverLoaded = false;
    private volatile boolean pageLoadFailed = false;
    private boolean pageLoading = false;
    private boolean serviceStartRequested = false;
    private boolean discoveryRunning = false;
    private long lastDiscoveryFail = 0;
    private String currentUrl;
    private String appliedTheme;
    private long loadStart;
    private boolean resumed;
    private boolean destroyed;
    private int reconnectAttempts;
    private long reconnectAt;
    private boolean networkRecoveryPending;
    private boolean connectionCheckBusy;
    private int pageGeneration;
    private String lastConnectionState = "";

    private boolean canReconnect() {
        return !pageLoadFailed || (Prefs.get(this, Prefs.AUTO_RECONNECT, true)
            && android.os.SystemClock.elapsedRealtime() >= reconnectAt);
    }

    private void requestReconnect() {
        reconnectAt = 0;
        if ("zcode".equals(appMode)) zcodeLoadStarted = false;
        pageLoadFailed = false;
        pageLoading = false;
        pageEverLoaded = false;
        if (web != null) web.stopLoading();
        poll();
    }

    private void schedulePoll() {
        handler.removeCallbacks(ticker);
        if (resumed && !destroyed) handler.post(ticker);
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            handler.removeCallbacks(this);
            if (!resumed || destroyed) return;
            poll();
            handler.postDelayed(this, pageEverLoaded ? 4000 : 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Diagnostics.event(this,1,0,0);
        ThemePalette tp = ThemePalette.get(this);
        BG = tp.bg;
        BAR = tp.bar;
        TEXT = tp.text;
        DIM = tp.dim;
        ACCENT = tp.accent;
        appliedTheme = tp.id;
        // kill the black flash before content is up: the window itself follows the theme
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
        ThemePalette.applySystemBars(getWindow(), BG, BAR);
        currentUrl = Prefs.effectiveUrl(this);
        Tunnel.get(this).ensureEngine();
        LocalForwarder.start(Prefs.hostOf(currentUrl)); // loopback services ready as early as possible
        registerNetworkWatch();
        final boolean instant = savedInstanceState != null; // recreate() after theme change
        // warm-up: mount the web surface immediately; the splash floats above it
        // so the page truly loads behind the curtain.
        buildMain();
        final FrameLayout wrap = new FrameLayout(this);
        wrap.addView(mainRoot, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View splash = null;
        if (!instant) {
            bootStartMs = System.currentTimeMillis();
            splash = buildSplashView();
            final View fs = splash;
            wrap.addView(fs, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        setContentView(wrap);
        applyWindowPrefs();
        applyOrientationFor(false);
        handler.post(ticker);
        if (getIntent() != null && getIntent().getBooleanExtra("login", false)) {
            handler.postDelayed(new Runnable() { @Override public void run() { beginLogin(); } }, 500);
        }
        if (!instant) {
            handler.postDelayed(new Runnable() {
                @Override public void run() {
                    askMicPermission(); // voice input is core: ask the system up front
                }
            }, 700);
        }
    }

    // ------------------------------------------------------------- splash

    private BootAnimView bootView;
    private boolean bootDismissQueued;

    private View buildSplashView() {
        bootView = new BootAnimView(this);
        return bootView;
    }

    private void removeBoot() {
        try {
            if (bootView == null || !(bootView.getParent() instanceof ViewGroup)) return;
            if (bootDismissQueued) return;
            // Preserve the requested slow right-to-left author animation.
            long elapsed = System.currentTimeMillis() - bootStartMs;
            if (elapsed < 4700) {
                bootDismissQueued = true;
                handler.postDelayed(new Runnable() {
                    @Override public void run() {
                        bootDismissQueued = false;
                        if (!destroyed) removeBoot();
                    }
                }, 4700 - elapsed);
                return;
            }
            bootDismissQueued = true;
            final ViewGroup p = (ViewGroup) bootView.getParent();
            bootView.animate().alpha(0f).setDuration(180).withEndAction(new Runnable() {
                @Override public void run() {
                    try { p.removeView(bootView); } catch (Exception ignored) {}
                }
            }).start();
        } catch (Exception ignored) {}
    }

    // --------------------------------------------------------------- main

    private void buildMain() {
        mainRoot = new LinearLayout(this);
        mainRoot.setOrientation(LinearLayout.VERTICAL);
        mainRoot.setBackgroundColor(BG);
        mainRoot.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        toolbar=bar;
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(BAR);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(4), dp(3), dp(4), dp(3));
        sidebarBtn = iconButton(R.drawable.ic_menu, v -> {
            if (web != null && "dsh".equals(appMode)) {
                web.evaluateJavascript("window.__dshToggleSidebar&&window.__dshToggleSidebar()", null);
            }
        });
        sidebarBtn.setContentDescription("展开或收起会话侧边栏");
        bar.addView(sidebarBtn);

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setGravity(Gravity.CENTER_VERTICAL);
        titles.setPadding(dp(4), 0, 0, 0);
        LinearLayout switcher = new LinearLayout(this);
        switcher.setOrientation(LinearLayout.HORIZONTAL);
        switcher.setGravity(Gravity.CENTER_VERTICAL);
        pillDsh = modePill("DSHgo");
        pillZcode = modePill("ZCode go");
        pillDsh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { switchMode("dsh"); }
        });
        pillZcode.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { switchMode("zcode"); }
        });
        switcher.addView(pillDsh);
        switcher.addView(pillZcode);
        titles.addView(switcher);
        appMode = Prefs.get(this).getString(Prefs.MODE, "dsh");
        stylePills();
        subtitleView = new TextView(this);
        subtitleView.setText("启动中…");
        subtitleView.setTextColor(DIM);
        subtitleView.setTextSize(11);
        connectionBadge=new LinearLayout(this);connectionBadge.setGravity(Gravity.CENTER_VERTICAL);
        statusFish=new ImageView(this);statusFish.setImageResource(R.drawable.ic_launcher);
        statusFish.setScaleType(ImageView.ScaleType.FIT_CENTER);statusFish.setContentDescription("大肥鱼连接状态");
        connectionBadge.addView(statusFish,new LinearLayout.LayoutParams(dp(24),dp(24)));
        subtitleView.setMaxLines(1);subtitleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        connectionBadge.addView(subtitleView,new LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1));
        titles.addView(connectionBadge);
        bar.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        dot = new View(this);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(0xFFF5C542);
        dot.setBackground(d);
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(dp(9), dp(9));
        dl.setMargins(0, 0, dp(12), 0);
        dot.setLayoutParams(dl);
        bar.addView(dot);

        bar.addView(iconButton(R.drawable.ic_refresh, new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (web != null && pageEverLoaded) new AlertDialog.Builder(MainActivity.this)
                    .setTitle("重新载入工作台？").setMessage("重新载入可能清除未发送草稿，并中断上传。网络恢复通常无需刷新。")
                    .setNegativeButton("保留页面",null).setPositiveButton("重新载入",(d,w)->web.reload()).show();
                else requestReconnect();
            }
        }));
        globeBtn = iconButton(R.drawable.ic_globe, new View.OnClickListener() {
            @Override public void onClick(View v) { showSiteDialog(); }
        });
        bar.addView(globeBtn);
        bar.addView(iconButton(R.drawable.ic_settings, new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, SettingsActivity.class));
            }
        }));

        mainRoot.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));
        applyFishChrome();

        topBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        topBar.setMax(100);
        topBar.setVisibility(View.GONE);
        mainRoot.addView(topBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        web = new WebView(this);
        setupWeb(web, false);

        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(BG);
        overlay.setPadding(dp(16), dp(16), dp(16), dp(16));

        ImageView logo = new ImageView(this);
        stateArt=logo;
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setContentDescription("DSHgo 状态插画");
        logo.setImageResource(R.drawable.ic_launcher);
        overlay.addView(logo, new LinearLayout.LayoutParams(dp(92), dp(92)));
        updateStateArt();

        statusTitle = new TextView(this);
        statusTitle.setTextColor(TEXT);
        statusTitle.setTextSize(19);
        statusTitle.setGravity(Gravity.CENTER);
        statusTitle.setPadding(0, dp(24), 0, dp(6));
        overlay.addView(statusTitle, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        statusSub = new TextView(this);
        statusSub.setTextColor(DIM);
        statusSub.setTextSize(13.5f);
        statusSub.setGravity(Gravity.CENTER);
        overlay.addView(statusSub, new LinearLayout.LayoutParams(dp(290), ViewGroup.LayoutParams.WRAP_CONTENT));

        actionBtn = new Button(this);
        actionBtn.setTextColor(Color.WHITE);
        actionBtn.setTextSize(15);
        actionBtn.setAllCaps(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(ACCENT);
        bg.setCornerRadius(dp(12));
        actionBtn.setBackground(bg);
        actionBtn.setPadding(dp(30), dp(6), dp(30), dp(6));
        LinearLayout.LayoutParams bl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bl.topMargin = dp(22);
        overlay.addView(actionBtn, bl);
        actionBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { onPrimaryAction(); }
        });

        // ---- login layer (Tailscale account, stays inside this app) ----
        loginLayer = new FrameLayout(this);
        loginLayer.setBackgroundColor(BG);
        loginLayer.setVisibility(View.GONE);
        LinearLayout loginTop = new LinearLayout(this);
        loginTop.setOrientation(LinearLayout.HORIZONTAL);
        loginTop.setBackgroundColor(BAR);
        loginTop.setGravity(Gravity.CENTER_VERTICAL);
        TextView lt = new TextView(this);
        lt.setText("登录 Tailscale 账号");
        lt.setTextColor(TEXT);
        lt.setTextSize(16);
        lt.setPadding(dp(16), dp(12), 0, dp(12));
        loginTop.addView(lt, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        TextView lc = new TextView(this);
        lc.setText("✕");
        lc.setTextColor(DIM);
        lc.setTextSize(18);
        lc.setPadding(dp(18), dp(12), dp(18), dp(12));
        lc.setClickable(true);
        lc.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { hideLogin(); }
        });
        loginTop.addView(lc);
        LinearLayout loginWrap = new LinearLayout(this);
        loginWrap.setOrientation(LinearLayout.VERTICAL);
        loginWrap.addView(loginTop, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        loginWeb = new WebView(this);
        setupWeb(loginWeb, true);
        loginWrap.addView(loginWeb, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        loginLayer.addView(loginWrap, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        FrameLayout stack = new FrameLayout(this);
        this.stack = stack;
        stack.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        stack.addView(overlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        stack.addView(loginLayer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        mainRoot.addView(stack, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
    }

    private View iconButton(int res, View.OnClickListener click) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(res);
        // theme-aware glyph tint: fixed light vectors vanish on light themes
        iv.setColorFilter(TEXT, android.graphics.PorterDuff.Mode.SRC_IN);
        iv.setPadding(dp(8), dp(10), dp(8), dp(10));
        iv.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        if (res == R.drawable.ic_refresh) iv.setContentDescription("刷新");
        if (res == R.drawable.ic_settings) iv.setContentDescription("设置");
        if (res == R.drawable.ic_globe) iv.setContentDescription("站点小窗");
        iv.setClickable(true);
        iv.setOnClickListener(click);
        iv.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                v.setAlpha(e.getAction() == MotionEvent.ACTION_DOWN ? 0.55f : 1f);
                return false;
            }
        });
        return iv;
    }

    // ------------------------------------------------------------ actions

    private void onPrimaryAction() {
        if (state == ST_NEED_LOGIN) {
            beginLogin();
            return;
        }
        if (state == ST_NEED_VPN) {
            requestVpn();
            return;
        }
        requestReconnect();
    }

    // --------------------------------------------- multi-site aggregation

    /** Sites open in a floating window over the main UI — never replacing it. */
    private FrameLayout sitePopup;
    private WebView siteWeb;

    private void showSitePopup(String name, String url) {
        removeSitePopup();
        if (stack == null || url == null || url.isEmpty()) return;

        // tailnet sites need the tunnel: leave ZCode (tunnel-off) mode first
        boolean tailnet = url.contains(".ts.net");
        if (tailnet && "zcode".equals(appMode)) switchMode("dsh");

        sitePopup = new FrameLayout(this);
        sitePopup.setBackgroundColor(0x8A000000);
        sitePopup.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { removeSitePopup(); } // tap empty closes
        });

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable cd = new GradientDrawable();
        cd.setCornerRadius(dp(16));
        cd.setColor(BG);
        card.setBackground(cd);
        card.setClickable(true); // keep taps inside the card from falling through
        card.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {}
        });

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(16), dp(12), dp(8), dp(12));
        TextView t = new TextView(this);
        t.setText(name);
        t.setTextColor(TEXT);
        t.setTextSize(15);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        TextView retry = new TextView(this);
        retry.setText("↻");
        retry.setTextColor(DIM);
        retry.setTextSize(18);
        retry.setPadding(dp(12), 0, dp(10), 0);
        retry.setClickable(true);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (siteWeb != null) siteWeb.reload();
            }
        });
        head.addView(retry);
        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(DIM);
        close.setTextSize(17);
        close.setPadding(dp(10), 0, dp(8), 0);
        close.setClickable(true);
        close.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { removeSitePopup(); }
        });
        head.addView(close);
        card.addView(head);

        siteWeb = new WebView(this);
        setupWeb(siteWeb, true); // plain browsing: no workbench state coupling
        siteWeb.setWebChromeClient(new WebChromeClient());
        siteWeb.loadUrl(url);
        card.addView(siteWeb, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.gravity = Gravity.CENTER;
        lp.leftMargin = dp(18); lp.rightMargin = dp(18);
        lp.topMargin = dp(64); lp.bottomMargin = dp(64);
        sitePopup.addView(card, lp);
        stack.addView(sitePopup, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void removeSitePopup() {
        if (sitePopup != null && stack != null) {
            try {
                if (siteWeb != null) {
                    siteWeb.stopLoading();
                    siteWeb.loadUrl("about:blank");
                    siteWeb.destroy();
                    siteWeb = null;
                }
                stack.removeView(sitePopup);
            } catch (Exception ignored) {}
            sitePopup = null;
        }
    }

    private void showSiteDialog() {
        try {
            final org.json.JSONArray sites = Prefs.getSites(this);
            final java.util.ArrayList<String> names = new java.util.ArrayList<>();
            final java.util.ArrayList<String> urls = new java.util.ArrayList<>();
            for (int i = 0; i < sites.length(); i++) {
                org.json.JSONObject o = sites.optJSONObject(i);
                if (o != null) {
                    names.add(o.optString("name", "站点 " + (i + 1)));
                    urls.add(o.optString("url", ""));
                }
            }
            if (names.isEmpty()) {
                new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                    .setTitle("站点小窗")
                    .setMessage("还没有站点。到设置 → 站点管理里添加本地页面或 ZCode 链接。")
                    .setPositiveButton("去设置", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface d, int which) {
                            startActivity(new Intent(MainActivity.this, SettingsActivity.class));
                        }
                    })
                    .setNegativeButton("取消", null)
                    .show();
                return;
            }
            new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("站点小窗（弹出显示，不影响主界面）")
                .setItems(names.toArray(new String[0]), new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int which) {
                        showSitePopup(names.get(which), urls.get(which));
                    }
                })
                .setNeutralButton("管理站点…", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int which) {
                        startActivity(new Intent(MainActivity.this, SettingsActivity.class));
                    }
                })
                .setNegativeButton("取消", null)
                .show();
        } catch (Exception e) {
            android.widget.Toast.makeText(this, "站点列表读取失败: " + e.getMessage(), android.widget.Toast.LENGTH_SHORT).show();
        }
    }

    private void switchSite(int idx) {
        try {
            org.json.JSONArray sites = Prefs.getSites(this);
            String url;
            if (idx <= 0) {
                url = Prefs.serverUrl(this);
                Prefs.get(this).edit().putString(Prefs.TARGET_MODE, "auto").apply();
                url = Prefs.effectiveUrl(this);
            } else {
                org.json.JSONObject o = sites.optJSONObject(idx - 1);
                url = o != null ? o.optString("url", Prefs.effectiveUrl(this)) : Prefs.effectiveUrl(this);
            }
            Prefs.get(this).edit().putInt(Prefs.ACTIVE_SITE, idx).apply();
            currentUrl = url;
            pageEverLoaded = false;
            pageLoading = false;
            state = ST_CONNECTING;
            statusTitle.setText(idx <= 0 ? "正在连接远程桌面" : "正在打开站点…");
            statusSub.setText(url);
            overlay.setVisibility(View.VISIBLE);
            setDot(0xFFF5C542);
            if (web != null) {
                web.stopLoading();
                web.loadUrl(url);
            }
            schedulePoll();
        } catch (Exception e) {
            android.widget.Toast.makeText(this, "切换失败: " + e.getMessage(), android.widget.Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------- DSHgo / ZCode go modes

    private String appMode = "dsh"; // dsh | zcode
    private TextView pillDsh, pillZcode;
    private View sidebarBtn;
    private View globeBtn;
    private boolean zcodeLoadStarted = false;

    /** Site mini-window is an optional power feature (default off). */
    private void applySiteSwitch() {
        if (globeBtn == null) return;
        boolean on = Prefs.get(this, Prefs.SITE_POPUP, false);
        globeBtn.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    private TextView modePill(String label) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(12);
        tv.setPadding(dp(8), dp(5), dp(8), dp(5));
        tv.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(6);
        tv.setLayoutParams(lp);
        return tv;
    }

    private void stylePills() {
        if (pillDsh == null || pillZcode == null) return;
        boolean dsh = "dsh".equals(appMode);
        if (sidebarBtn != null) sidebarBtn.setVisibility(dsh ? View.VISIBLE : View.GONE);
        GradientDrawable on = new GradientDrawable();
        on.setCornerRadius(dp(14));
        on.setColor(ACCENT);
        GradientDrawable off = new GradientDrawable();
        off.setCornerRadius(dp(14));
        off.setColor(0x00000000);
        pillDsh.setBackground(dsh ? on : off);
        pillDsh.setTextColor(dsh ? Color.WHITE : DIM);
        pillZcode.setBackground(dsh ? off : on);
        pillZcode.setTextColor(dsh ? DIM : Color.WHITE);
    }

    /**
     * Mode switch: DSHgo runs through the tunnel, ZCode go is direct https and
     * turns the tunnel OFF (no VPN permission theatre around a public site);
     * switching back turns it ON again automatically.
     */
    private void switchMode(String mode) {
        if (mode == null || mode.equals(appMode)) return;
        finishFileChooser(null);
        appMode = mode;
        Prefs.get(this).edit().putString(Prefs.MODE, mode).apply();
        stylePills();
        removeSitePopup();
        pageEverLoaded = false;
        pageLoading = false;
        if ("zcode".equals(mode)) {
            String url = Prefs.get(this).getString(Prefs.ZCODE_URL, "");
            currentUrl = url;
            if (url == null || url.isEmpty()) {
                stopTunnel(); // still drop the tunnel: user asked for ZCode mode
                state = ST_CONNECTING;
                statusTitle.setText("ZCode go");
                statusSub.setText("还没有 ZCode 远程链接：设置 → ZCode 远程链接 里填入");
                subtitleView.setText("ZCode 未配置");
                overlay.setVisibility(View.VISIBLE);
                actionBtn.setVisibility(View.GONE);
                setDot(0xFFF5C542);
                if (bootView != null) bootView.setStatus("ZCode go");
            } else {
                // Load FIRST (direct https works with or without the tunnel),
                // then drop the tunnel after the session is established — killing
                // it mid-handshake is what made the link "restart".
                subtitleView.setText("ZCode 直连中");
                if (bootView != null) bootView.setStatus("正在载入 ZCode…");
                if (web != null) {
                    zcodeLoadStarted = true; // poll() must not double-load this
                    pageLoading = true;
                    pageLoadFailed = false;
                    web.stopLoading();
                    web.loadUrl(url);
                }
                handler.postDelayed(new Runnable() {
                    @Override public void run() {
                        if ("zcode".equals(appMode)) stopTunnel();
                    }
                }, 3000);
            }
        } else {
            subtitleView.setText("隧道连接中");
            if (bootView != null) bootView.setStatus("正在建立加密隧道…");
            currentUrl = Prefs.effectiveUrl(this);
            zcodeLoadStarted = false;
            serviceStartRequested = false; // re-arm the tunnel
            schedulePoll();
        }
        schedulePoll();
    }

    private void stopTunnel() {
        LocalForwarder.stop();
        try {
            Intent i = new Intent(this, TailscaleVpnService.class)
                .setAction(TailscaleVpnService.ACTION_STOP);
            startService(i);
        } catch (Exception ignored) {}
        serviceStartRequested = false;
    }

    private void beginLogin() {
        Tunnel.get(this).ensureEngine();
        // Wake the engine's control channel first (official flow: run the
        // service in foreground-only mode during interactive login).
        try {
            Intent i = new Intent(this, TailscaleVpnService.class)
                .setAction(TailscaleVpnService.ACTION_START_FOREGROUND_ONLY);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception ignored) {}
        String url = Tunnel.get(this).startLogin();
        loginLayer.setVisibility(View.VISIBLE);
        statusSub.setText("请在登录页完成授权");
        if (url != null && !url.isEmpty()) {
            loginWeb.loadUrl(url);
        } else {
            statusTitle.setText("正在准备登录页…");
        }
    }

    private void hideLogin() {
        loginLayer.setVisibility(View.GONE);
        if (loginWeb != null) loginWeb.stopLoading();
    }

    private void requestVpn() {
        try {
            Intent i = VpnService.prepare(this);
            if (i != null) {
                startActivityForResult(i, REQ_VPN);
            } else {
                startTunnelService();
            }
        } catch (Exception e) {
            statusSub.setText("无法请求 VPN 权限：" + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILES) {
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            java.util.ArrayList<Uri> readable = new java.util.ArrayList<>();
            if (result != null) {
                for (Uri uri : result) {
                    // SAF grants access to selected content URIs; never accept arbitrary
                    // file:// paths or web URLs from another app's activity result.
                    if (uri != null && "content".equals(uri.getScheme())) readable.add(uri);
                }
            }
            finishFileChooser(readable.isEmpty() ? null : readable.toArray(new Uri[0]));
            return;
        }
        if (requestCode == REQ_VPN && resultCode == RESULT_OK) {
            startTunnelService();
        }
    }

    private void finishFileChooser(Uri[] result) {
        android.webkit.ValueCallback<Uri[]> callback = fileChooser;
        fileChooser = null;
        if (callback != null) callback.onReceiveValue(result);
    }

    private boolean chooseFiles(android.webkit.ValueCallback<Uri[]> callback,
            WebChromeClient.FileChooserParams params) {
        finishFileChooser(null);
        fileChooser = callback;
        java.util.LinkedHashSet<String> types = new java.util.LinkedHashSet<>();
        for (String group : params.getAcceptTypes()) {
            if (group == null) continue;
            for (String item : group.split(",")) {
                String type = item.trim().toLowerCase(java.util.Locale.ROOT);
                if (type.startsWith(".")) {
                    type = android.webkit.MimeTypeMap.getSingleton()
                        .getMimeTypeFromExtension(type.substring(1));
                }
                if (type != null && type.matches("[a-z0-9.+*-]+/[a-z0-9.+*-]+")) types.add(type);
            }
        }
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        pick.setType(types.size() == 1 ? types.iterator().next() : "*/*");
        if (types.size() > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
            params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        try {
            startActivityForResult(pick, REQ_FILES);
        } catch (android.content.ActivityNotFoundException e) {
            finishFileChooser(null);
            android.widget.Toast.makeText(this, "没有可用的文件选择器", android.widget.Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void startTunnelService() {
        Intent i = new Intent(this, TailscaleVpnService.class)
            .setAction(TailscaleVpnService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
            serviceStartRequested = true;
            vpnRequestAt = System.currentTimeMillis();
        } catch (Exception e) {
            statusSub.setText("启动隧道失败：" + e.getMessage());
        }
    }

    private long vpnRequestAt = 0;

    /** System-level truth: is a VPN network actually established? */
    private boolean vpnNetworkUp() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                getSystemService(CONNECTIVITY_SERVICE);
            android.net.Network[] nets = cm.getAllNetworks();
            for (android.net.Network n : nets) {
                android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                if (nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                    && (Build.VERSION.SDK_INT < 29 || nc.getOwnerUid() == android.os.Process.myUid())) {
                    return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    // ---------------------------------------------------------------- web

    private void setupWeb(final WebView wv, final boolean isLogin) {
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // Never reuse an old workbench bootstrap or API response while offline.
        if (!isLogin) s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // Read only the content URIs selected through Android's picker.
        // The workbench loads local resources over http://127.0.0.1 (loopback).
        // Browsers whitelist loopback from mixed-content blocking; WebView must
        // be told explicitly, otherwise images say "file service unavailable".
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        applyWebPrefs(wv);

        wv.setBackgroundColor(BG);
        if(!isLogin) wv.addJavascriptInterface(new Object(){
            @android.webkit.JavascriptInterface public void signal(int kind,long bytes,int reason){Diagnostics.signal(getApplicationContext(),kind,bytes,reason);}
            @android.webkit.JavascriptInterface public void pageEvent(int kind,int detail){
                if(kind>=1&&kind<=5&&detail>=0&&detail<=8)Diagnostics.event(getApplicationContext(),16,kind,detail);
            }
        },"DSHDiagnostics");
        wv.setLongClickable(false);

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (isLogin || destroyed) return;
                pageGeneration++;
                connectionCheckBusy = false;
                networkRecoveryPending = false;
                state = ST_CONNECTING;
                pageLoading = true;
                pageLoadFailed = false;
                loadStart = System.currentTimeMillis();
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if(!EndpointPolicy.allowsCleartext(uri.toString())){
                    Diagnostics.event(MainActivity.this,17,1,request.isForMainFrame()?1:0);
                    return new android.webkit.WebResourceResponse("text/plain","UTF-8",403,"Blocked",java.util.Collections.emptyMap(),new java.io.ByteArrayInputStream("Use HTTPS for public servers".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                }
                if(!isLogin && "dsh".equals(appMode) && uri.getPath()!=null && uri.getPath().startsWith("/__dsh/android-skin/")
                    && uri.getAuthority()!=null && uri.getAuthority().equals(Uri.parse(currentUrl).getAuthority())){
                    String name=uri.getLastPathSegment();int res="mascot.png".equals(name)?R.drawable.ic_launcher:"happy.webp".equals(name)?R.drawable.fish_happy:"error.webp".equals(name)?R.drawable.fish_error:0;
                    if(res!=0)return new android.webkit.WebResourceResponse(name.endsWith("png")?"image/png":"image/webp",null,getResources().openRawResource(res));
                }
                return null;
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (isLogin) return false; // login flows anywhere
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                if(!EndpointPolicy.allowsCleartext(u.toString())){openExternally(u.toString());return true;}
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // ZCode mode: its SPA hops hosts during auth/session setup —
                    // keep every hop inside the WebView or the session "restarts".
                    if ("zcode".equals(appMode)) return false;
                    boolean sameHost = Prefs.hostOf(currentUrl).equals(u.getHost());
                    if (sameHost) return false;
                    if (Prefs.get(MainActivity.this, Prefs.EXT_LINKS, true)) {
                        openExternally(u.toString());
                        return true;
                    }
                    return false;
                }
                if ("about".equals(scheme)) return false;
                openExternally(u.toString());
                return true;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                if (!isLogin && !destroyed) injectAdaptation();
            }

            @Override
            public void onLoadResource(WebView view, String url) {
                if (!isLogin && !destroyed && !pageLoadFailed) injectAdaptation();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (isLogin || destroyed) return;
                final int generation = pageGeneration;
                view.evaluateJavascript("document.documentURI.indexOf('chrome-error:')===0",
                    new android.webkit.ValueCallback<String>() {
                        @Override public void onReceiveValue(String errorDocument) {
                            if (destroyed || generation != pageGeneration) return;
                            pageLoading = false;
                            // Chromium can start its internal error document
                            // after onReceivedError, resetting the old flag.
                            if (pageLoadFailed || "true".equals(errorDocument)) {
                                pageLoadFailed = true;
                                pageEverLoaded = false;
                                setState(ST_ERROR);
                                return;
                            }
                            pageEverLoaded = true;
                            reconnectAttempts = 0;
                            reconnectAt = 0;
                            setState(ST_READY);
                            injectAdaptation();
                        }
                    });
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (!isLogin && !destroyed && req.isForMainFrame()) {
                    Diagnostics.event(MainActivity.this,4,err.getErrorCode(),0);
                    pageLoadFailed = true;
                    pageEverLoaded = false;
                    pageLoading = false;
                    setState(ST_ERROR);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req,
                    android.webkit.WebResourceResponse response) {
                String path=req.getUrl().getPath();
                int category=path!=null&&path.startsWith("/plugins/")?1:path!=null&&path.startsWith("/assets/")?2:0;
                if(category!=0||req.isForMainFrame())Diagnostics.event(MainActivity.this,18,response.getStatusCode(),category);
                if (!isLogin && !destroyed && req.isForMainFrame() && response.getStatusCode() >= 500) {
                    pageLoadFailed = true;
                    pageEverLoaded = false;
                    pageLoading = false;
                    setState(ST_ERROR);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                Diagnostics.event(MainActivity.this,5,error.getPrimaryError(),0);
                handler.cancel();
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                return chooseFiles(callback, params);
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage cm) {
                if(cm.messageLevel()==android.webkit.ConsoleMessage.MessageLevel.ERROR) Diagnostics.event(MainActivity.this,10,1,0);
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int p) {
                if (!isLogin) {
                    if (p < 100) {
                        topBar.setVisibility(View.VISIBLE);
                        topBar.setProgress(p);
                    } else {
                        topBar.setVisibility(View.GONE);
                    }
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                // Sites (e.g. ZCode) open sessions via window.open. Denying it
                // makes the page fall back to a full navigation — the visible
                // "session restart" bug. Capture the target URL and load it in
                // the same WebView instead.
                try {
                    WebView temp = new WebView(view.getContext());
                    temp.setWebViewClient(new WebViewClient() {
                        @Override
                        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                            final String u = req.getUrl().toString();
                            handler.post(new Runnable() {
                                @Override public void run() {
                                    if (web != null) web.loadUrl(u);
                                }
                            });
                            return true;
                        }
                    });
                    android.webkit.WebView.WebViewTransport transport =
                        (android.webkit.WebView.WebViewTransport) resultMsg.obj;
                    transport.setWebView(temp);
                    resultMsg.sendToTarget();
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (hasMicPermission()) {
                            request.grant(request.getResources());
                        } else {
                            request.deny();
                            askMicPermission();
                        }
                    }
                });
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                nativeDialog(message, null, result);
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                nativeDialog(message, result, null);
                return true;
            }
        });
    }

    private void applyWebPrefs(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setTextZoom(Prefs.fontPct(this));
        if (Prefs.get(this, Prefs.DESKTOP_UA, false)) {
            s.setUserAgentString(UA_DESKTOP);
        } else {
            // Use the exact Chrome-on-Android UA: the server may feature-detect
            // "WebView" and serve a reduced file service.
            s.setUserAgentString(WebSettings.getDefaultUserAgent(this));
        }
    }

    private void applyWindowPrefs() {
        if (Prefs.get(this, Prefs.KEEP_SCREEN, true)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        if (Prefs.get(this, Prefs.FULLSCREEN, false)) {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
        ThemePalette.applySystemBars(getWindow(),BG,BAR);
    }

    private void nativeDialog(String message, final JsResult confirm, final JsResult alertOnly) {
        AlertDialog.Builder b = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK);
        b.setMessage(message);
        b.setCancelable(false);
        if (confirm != null) {
            b.setPositiveButton(android.R.string.ok, (d, w) -> confirm.confirm());
            b.setNegativeButton(android.R.string.cancel, (d, w) -> confirm.cancel());
        } else {
            b.setPositiveButton(android.R.string.ok, (d, w) -> {
                if (alertOnly != null) alertOnly.confirm();
            });
        }
        b.show();
    }

    private long lastAdaptationAt;

    private void injectAdaptation() {
        if ("zcode".equals(appMode)) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastAdaptationAt < 250) return;
        lastAdaptationAt = now;
        try {
            if (mobileUiScript == null) {
                try (InputStream in = getResources().openRawResource(R.raw.mobile_ui);
                     java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    mobileUiScript = out.toString("UTF-8");
                }
            }
            web.evaluateJavascript("window.__dshAutoSidebar="
                + Prefs.get(this, Prefs.AUTO_SIDEBAR, true) + ";window.__dshFishSkin="+"fish".equals(appliedTheme)+";" + mobileUiScript, null);
        } catch (Exception e) {
            android.util.Log.w("DSHWeb", "mobile UI setup failed", e);
        }
    }

    // ------------------------------------------------------- connection

    private String orientationMode() {
        return Prefs.get(this).getString(Prefs.ORIENTATION, "smart");
    }

    private void applyOrientationFor(boolean wideDialog) {
        String mode = orientationMode();
        if ("system".equals(mode)) {
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else if ("landscape".equals(mode)) {
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        } else {
            // portrait is the default way to use this on a phone (incl. "smart")
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
    }

    private boolean wideDialog = false;

    private void poll() {
        if (mainRoot == null || destroyed || !resumed) return;
        // safety: never trap the user behind the boot curtain for good
        if (bootView != null && bootStartMs > 0
            && System.currentTimeMillis() - bootStartMs > 30000) {
            bootRevealed = true;
            removeBoot();
        }
        // ZCode go mode: direct https, no tunnel logic at all. The ZCode page
        // owns its live session — poll() must NEVER reload it: its SPA navigates
        // with pushState, and any URL-based reload re-enters the whole session.
        // Only the very first load and failed-load recovery touch the WebView.
        if ("zcode".equals(appMode)) {
            String zu = Prefs.get(this).getString(Prefs.ZCODE_URL, "");
            if (zu == null || zu.isEmpty()) return;
            if (!zcodeLoadStarted) {
                zcodeLoadStarted = true;
                currentUrl = zu; // cold start: currentUrl still holds the DSH url
                pageLoading = true;
                pageLoadFailed = false;
                web.loadUrl(zu);
            } else if (pageLoadFailed && !pageLoading) {
                if (!canReconnect()) return;
                pageLoading = true;
                pageLoadFailed = false;
                web.loadUrl(currentUrl);
            }
            return;
        }
        final Tunnel tunnel = Tunnel.get(this);

        // login page open: wait until the engine reports a logged-in profile
        if (loginLayer.getVisibility() == View.VISIBLE) {
            if (tunnel.isLoggedIn()) {
                hideLogin();
                statusTitle.setText("登录成功");
                statusSub.setText("正在建立加密隧道…");
                // drop the pre-login page state so the workbench loads fresh
                pageEverLoaded = false;
                pageLoading = false;
            } else {
                String url = tunnel.browseURL();
                if (url == null || url.isEmpty()) url = tunnel.authURL();
                if (url != null && !url.isEmpty() && loginWeb.getUrl() == null) {
                    loginWeb.loadUrl(url);
                }
                return;
            }
        }

        if (!tunnel.isEngineUp()) {
            tunnel.ensureEngine();
            statusTitle.setText("正在初始化");
            statusSub.setText("启动内置隧道内核…");
            setDot(0xFFF5C542);
            return;
        }

        if (tunnel.needsLogin()) {
            setState(ST_NEED_LOGIN);
            return;
        }

        if (!tunnel.isLoggedIn()) {
            // status not confirmed yet (weak network / engine still warming up):
            // this is "connecting", never "please log in" — mislabelling stalls
            // as 待登录 was the single worst confusion on campus networks.
            state = ST_TUNNEL;
            statusTitle.setText("正在连接远程桌面");
            statusSub.setText("正在确认隧道状态，网络较慢时会自动重试…");
            subtitleView.setText("连接中…");
            overlay.setVisibility(View.VISIBLE);
            actionBtn.setVisibility(View.GONE);
            setDot(0xFFF5C542);
            return;
        }

        if (VpnService.prepare(this) != null) {
            setState(ST_NEED_VPN);
            return;
        }

        // The engine can reach "Running" over the physical network long before
        // the tunnel device exists (that's exactly how DNS ended up broken).
        // So the VPN service is always started once authorized, and readiness
        // is judged by the system's VPN network, not by the engine state.
        if (!serviceStartRequested) startTunnelService();

        if (!vpnNetworkUp()) {
            if (System.currentTimeMillis() - vpnRequestAt > 12000) {
                serviceStartRequested = false; // self-heal: service died, re-request
            }
            state = ST_TUNNEL;
            statusTitle.setText("正在连接远程桌面");
            statusSub.setText("加密隧道建立中…");
            subtitleView.setText("隧道连接中");
            overlay.setVisibility(View.VISIBLE);
            actionBtn.setVisibility(View.GONE);
            setDot(0xFFF5C542);
            return;
        }

        if (!tunnel.isRunning()) {
            state = ST_TUNNEL;
            statusTitle.setText("正在连接远程桌面");
            statusSub.setText("加密隧道建立中…");
            subtitleView.setText("隧道连接中");
            overlay.setVisibility(View.VISIBLE);
            actionBtn.setVisibility(View.GONE);
            setDot(0xFFF5C542);
            return;
        }

        // tunnel is up: local services (inspector/file channel) get a loopback
        // forwarder so the page's ws://127.0.0.1:9230 works unchanged
        LocalForwarder.start(Prefs.hostOf(Prefs.effectiveUrl(this)));

        // tunnel is up: make sure we know the workbench endpoint
        if (Prefs.get(this, Prefs.AUTO_DISCOVER, true)
            && Prefs.get(this).getString(Prefs.DISCOVERED_URL, "").isEmpty()
            && Prefs.get(this).getString(Prefs.TARGET_MODE, "auto").equals("auto")) {
            if (!discoveryRunning && System.currentTimeMillis() - lastDiscoveryFail > 8000) {
                discoveryRunning = true;
                state = ST_DISCOVER;
                statusTitle.setText("正在连接远程桌面");
                statusSub.setText("已接入隧道，正在自动发现远程工作台…");
                subtitleView.setText("自动发现中");
                overlay.setVisibility(View.VISIBLE);
                actionBtn.setVisibility(View.GONE);
                setDot(0xFFF5C542);
                Discovery.find(tunnel, new Discovery.Callback() {
                    @Override public void onFound(final String url) {
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                discoveryRunning = false;
                                if (destroyed || !"dsh".equals(appMode)) return;
                                Prefs.get(MainActivity.this).edit().putString(Prefs.DISCOVERED_URL, url).apply();
                                currentUrl = url;
                                statusSub.setText("已发现远程工作台，正在载入…");
                            }
                        });
                    }

                    @Override public void onFailed(final String reason) {
                        runOnUiThread(new Runnable() {
                            @Override public void run() {
                                discoveryRunning = false;
                                if (destroyed || !"dsh".equals(appMode)) return;
                                lastDiscoveryFail = System.currentTimeMillis();
                                statusSub.setText(reason + "，自动重试中…");
                            }
                        });
                    }
                });
            }
            return;
        }

        currentUrl = Prefs.effectiveUrl(this);
        if (pageEverLoaded && !pageLoading) {
            // A temporary tunnel state must not make a loaded workbench fall
            // through into loadUrl(), losing its draft and live session.
            if (connectionCheckBusy) return;
            connectionCheckBusy = true;
            final int generation = pageGeneration;
            final boolean autoReconnect = Prefs.get(this, Prefs.AUTO_RECONNECT, true);
            String recovery = "";
            if (networkRecoveryPending) {
                networkRecoveryPending = false;
                web.setNetworkAvailable(true);
                recovery = "window.__dshNetworkChanged&&window.__dshNetworkChanged();";
            }
            web.evaluateJavascript(recovery + "window.__dshConnectionState?window.__dshConnectionState("
                + autoReconnect + "):'weak'", new android.webkit.ValueCallback<String>() {
                @Override public void onReceiveValue(String v) {
                    if (generation != pageGeneration) return;
                    connectionCheckBusy = false;
                    if (subtitleView == null || destroyed || !resumed) return;
                    String s = String.valueOf(v).replace("\"", "").trim();
                    if ("loading".equals(s) && System.currentTimeMillis() - loadStart > 180000) {
                        pageLoadFailed = true;
                        pageEverLoaded = false;
                        pageLoading = false;
                        setState(ST_ERROR);
                        return;
                    }
                    if (!s.equals(lastConnectionState)) {
                        Diagnostics.event(MainActivity.this,3,"ok".equals(s)?1:"bad".equals(s)?2:"reconnecting".equals(s)?3:"loading".equals(s)?4:"auth".equals(s)?6:"limited".equals(s)?7:"server".equals(s)?8:5,0);
                        lastConnectionState = s;
                    }
                    state = ST_READY;
                    overlay.setVisibility(View.GONE);
                    if ("bad".equals(s)) {
                        subtitleView.setText(autoReconnect ? "连接异常 · 自动重连中" : "连接异常");
                        setDot(0xFFFF5C5C);
                    } else if("auth".equals(s)||"server".equals(s)||"limited".equals(s)){
                        subtitleView.setText("auth".equals(s)?"登录已失效，请重新授权":"limited".equals(s)?"请求受限，请稍后重试":"电脑工作台服务异常");
                        setDot(0xFFF5C542);
                    } else if (!"ok".equals(s)) {
                        subtitleView.setText("reconnecting".equals(s) ? "正在恢复连接…" : "正在检查连接…");
                        setDot(0xFFF5C542);
                    } else {
                        subtitleView.setText("已连接");
                        setDot(0xFF3DDC84);
                    }
                }
            });
            // orientation intelligence: rotate when desktop-designed UI appears
            if ("smart".equals(orientationMode())) {
                web.evaluateJavascript("window.__dshDesktopWide?1:0", new android.webkit.ValueCallback<String>() {
                    @Override public void onReceiveValue(String v) {
                        boolean wide = "1".equals(String.valueOf(v).trim());
                        if (wide != wideDialog) {
                            wideDialog = wide;
                            applyOrientationFor(wide);
                        }
                    }
                });
            }
            return;
        }
        if (pageLoading) {
            // watchdog: a load stuck too long gets restarted (slow relays, drops),
            // but never while the user is actively typing
            if (!pageEverLoaded && System.currentTimeMillis() - loadStart > 180000) {
                web.stopLoading();
                pageLoading = false;
                pageLoadFailed = true;
                pageEverLoaded = false;
                setState(ST_ERROR);
            }
            return;
        }

        // Tunnel + endpoint are known: hand straight to the WebView, whose own
        // error handling covers slow links and temporary unreachability.
        if (!canReconnect()) return;
        pageLoading = true;
        pageLoadFailed = false;
        loadStart = System.currentTimeMillis();
        statusTitle.setText("正在连接远程桌面");
        statusSub.setText("正在载入 " + Prefs.hostOf(currentUrl) + " …");
        subtitleView.setText("连接中…");
        overlay.setVisibility(View.VISIBLE);
        actionBtn.setVisibility(View.GONE);
        setDot(0xFFF5C542);
        web.loadUrl(currentUrl);
    }

    private boolean probe() {
        // kept for diagnostics; the load path no longer depends on it
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(currentUrl).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            c.setRequestMethod("GET");
            c.getResponseCode();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private boolean bootRevealed = false;
    private long bootStartMs;

    /** Login/errors should become actionable as soon as the logo has appeared. */
    private void revealBootAfterAnim() {
        if (bootRevealed) return;
        bootRevealed = true;
        removeBoot();
    }

    private void setState(int st) {
        boolean newError = st == ST_ERROR && state != ST_ERROR;
        if(state!=st) Diagnostics.event(this,2,st,0);
        state = st;
        updateStateArt();
        if (bootView != null) {
            bootView.setStatus(st == ST_NEED_LOGIN ? "请登录 Tailscale 账号"
                : st == ST_NEED_VPN ? "正在开启加密隧道…"
                : st == ST_TUNNEL ? "正在建立加密隧道…"
                : st == ST_DISCOVER ? "正在发现远程工作台…"
                : st == ST_READY ? "已连接"
                : st == ST_ERROR ? "连接中断，自动重连中…"
                : "正在载入 DSH…");
        }
        if (st == ST_READY) {
            bootRevealed = true;
            removeBoot();
            overlay.setVisibility(View.GONE);
            setDot(0xFF3DDC84);
            subtitleView.setText("已连接");
        } else if (st == ST_NEED_LOGIN) {
            revealBootAfterAnim();
            overlay.setVisibility(View.VISIBLE);
            statusTitle.setText("欢迎使用 DSHgo");
            statusSub.setText("首次使用请登录 Tailscale 账号（仅此一次，之后自动连接）");
            subtitleView.setText("待登录");
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setText("登录账号");
            setDot(0xFFF5C542);
        } else if (st == ST_NEED_VPN) {
            revealBootAfterAnim();
            overlay.setVisibility(View.VISIBLE);
            statusTitle.setText("开启加密隧道");
            statusSub.setText("需要授权 VPN 权限（系统会弹一次确认，之后全自动）");
            subtitleView.setText("待授权");
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setText("开启隧道");
            setDot(0xFFF5C542);
        } else if (st == ST_ERROR) {
            revealBootAfterAnim();
            overlay.setVisibility(View.VISIBLE);
            statusTitle.setText("连接中断");
            statusSub.setText(Prefs.get(this, Prefs.AUTO_RECONNECT, true)
                ? "将自动重连，也可以点下方按钮立即重连"
                : "点下方按钮重新连接");
            subtitleView.setText("已断开");
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setText("立即重连");
            setDot(0xFFFF5C5C);
            if (newError) {
                long delay = Math.min(30000L, 2000L << Math.min(reconnectAttempts++, 4));
                reconnectAt = android.os.SystemClock.elapsedRealtime() + delay + (long)(Math.random() * 500);
            }
        }
    }

    private void applyFishChrome(){
        if(statusFish==null)return;
        boolean fish="fish".equals(appliedTheme);
        statusFish.setVisibility(fish?View.VISIBLE:View.GONE);
        connectionBadge.setPadding(dp(fish?3:0),0,dp(5),0);
        if(fish){GradientDrawable badge=new GradientDrawable();badge.setColor(0xFFE5F0FF);badge.setCornerRadius(dp(12));connectionBadge.setBackground(badge);}
        else connectionBadge.setBackground(null);
        if(toolbar!=null){GradientDrawable surface=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,fish?new int[]{0xFFF0F7FF,0xFFE1EDFF}:new int[]{BAR,BAR});toolbar.setBackground(surface);}
    }
    private void updateStateArt(){
        if(stateArt==null)return;
        boolean fish="fish".equals(appliedTheme);
        stateArt.setImageResource(fish?(state==ST_ERROR?R.drawable.fish_error:state==ST_NEED_LOGIN?R.drawable.fish_happy:R.drawable.fish_work):R.drawable.ic_launcher);
        stateArt.setLayoutParams(new LinearLayout.LayoutParams(dp(fish?184:92),dp(fish?184:92)));
    }
    /** Recolor in place: preserve the WebView, draft and upload workers. */
    private void applyLiveTheme(){
        int oldText=TEXT,oldDim=DIM;
        ThemePalette tp=ThemePalette.get(this);BG=tp.bg;BAR=tp.bar;TEXT=tp.text;DIM=tp.dim;ACCENT=tp.accent;appliedTheme=tp.id;
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
        recolor(mainRoot,oldText,oldDim);
        if(mainRoot!=null)mainRoot.setBackgroundColor(BG);
        if(toolbar!=null)toolbar.setBackgroundColor(BAR);
        if(overlay!=null)overlay.setBackgroundColor(BG);
        if(loginLayer!=null)loginLayer.setBackgroundColor(BG);
        if(web!=null)web.setBackgroundColor(BG);
        if(loginWeb!=null)loginWeb.setBackgroundColor(BG);
        if(actionBtn!=null&&actionBtn.getBackground() instanceof GradientDrawable)((GradientDrawable)actionBtn.getBackground()).setColor(ACCENT);
        stylePills();updateStateArt();applyFishChrome();applyWindowPrefs();
        if(web!=null)web.evaluateJavascript("window.__dshFishSkin="+"fish".equals(appliedTheme)+";window.__dshSetSkin&&window.__dshSetSkin(window.__dshFishSkin)",null);
    }
    private void recolor(View view,int oldText,int oldDim){
        if(view==null||view instanceof WebView)return;
        if(view instanceof TextView){TextView t=(TextView)view;int color=t.getCurrentTextColor();if(color==oldText)t.setTextColor(TEXT);else if(color==oldDim)t.setTextColor(DIM);}
        if(view instanceof ImageView && view!=stateArt)((ImageView)view).setColorFilter(TEXT,android.graphics.PorterDuff.Mode.SRC_IN);
        if(view instanceof ViewGroup){ViewGroup g=(ViewGroup)view;for(int i=0;i<g.getChildCount();i++)recolor(g.getChildAt(i),oldText,oldDim);}
    }
    private void setDot(int color) {
        ((GradientDrawable) dot.getBackground()).setColor(color);
    }

    private void openExternally(String uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(uri)));
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------- network change recovery (stability)

    private android.net.ConnectivityManager.NetworkCallback netCb;

    private void registerNetworkWatch() {
        try {
            android.net.ConnectivityManager cm =
                (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return;
            final NetworkChangePolicy pathPolicy=new NetworkChangePolicy();
            netCb=new android.net.ConnectivityManager.NetworkCallback(){
                private void refresh(){handler.post(()->{
                    if(destroyed)return;
                    android.net.Network best=SecureStore.physicalNetwork(cm);
                    android.net.NetworkCapabilities caps=best==null?null:cm.getNetworkCapabilities(best);
                    int change=pathPolicy.update(best==null?0:best.getNetworkHandle(),
                        caps!=null&&caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED),"");
                    if(change==0)return;
                    Diagnostics.network(MainActivity.this,caps);
                    Diagnostics.event(MainActivity.this,15,change,1);
                    if(pageEverLoaded)networkRecoveryPending=true;
                    if(resumed){
                        if(!pageEverLoaded&&!pageLoading)reconnectAt=0;
                        schedulePoll();
                    }
                });}
                @Override public void onAvailable(android.net.Network n){refresh();}
                @Override public void onLost(android.net.Network n){refresh();}
                @Override public void onCapabilitiesChanged(android.net.Network n,android.net.NetworkCapabilities c){refresh();}
            };
            cm.registerNetworkCallback(
                new android.net.NetworkRequest.Builder()
                    .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
                    .build(), netCb);
        } catch (Exception ignored) {}
    }

    // ------------------------------------------- microphone (voice input)

    private static final int REQ_MIC = 1002;

    private boolean hasMicPermission() {
        return Build.VERSION.SDK_INT < 23
            || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private void askMicPermission() {
        if (Build.VERSION.SDK_INT >= 23 && !hasMicPermission()) {
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC) {
            // voice input is a core feature: reflect the grant in the status line
            if (grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                if (statusSub != null) statusSub.setText("麦克风已就绪，语音输入可用");
            }
        }
    }

    private Bitmap circle(Bitmap src) {
        if (src == null) return null;
        Bitmap out = Bitmap.createBitmap(src.getWidth(), src.getHeight(), Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        float r = Math.min(src.getWidth(), src.getHeight()) / 2f;
        canvas.drawCircle(src.getWidth() / 2f, src.getHeight() / 2f, r, paint);
        return out;
    }

    // ----------------------------------------------------------- events

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        String t = Prefs.get(this).getString(Prefs.THEME, "midnight");
        if (appliedTheme != null && !appliedTheme.equals(t)) applyLiveTheme();
        if (web != null) {
            web.onResume();
            applyWebPrefs(web);
        }
        applyWindowPrefs();
        applySiteSwitch();
        if (web != null && pageEverLoaded && "dsh".equals(appMode)) {
            web.evaluateJavascript("window.__dshNetworkChanged&&window.__dshNetworkChanged();"
                + "window.__dshSetAutoSidebar&&window.__dshSetAutoSidebar("
                + Prefs.get(this, Prefs.AUTO_SIDEBAR, true) + ")", null);
        }
        String url = Prefs.effectiveUrl(this);
        if (mainRoot != null && "dsh".equals(appMode) && !url.equals(currentUrl) && pageEverLoaded) {
            currentUrl = url;
            pageLoadFailed = false;
            web.loadUrl(currentUrl);
        }
        schedulePoll();
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        if (web != null) web.onPause();
        handler.removeCallbacks(ticker);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        finishFileChooser(null);
        handler.removeCallbacksAndMessages(null);
        if (netCb != null) {
            try {
                ((android.net.ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE))
                    .unregisterNetworkCallback(netCb);
            } catch (Exception ignored) {}
        }
        removeSitePopup();
        super.onDestroy();
        if (web != null) web.destroy();
        if (loginWeb != null) loginWeb.destroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (loginLayer != null && loginLayer.getVisibility() == View.VISIBLE) {
                if (loginWeb.canGoBack()) {
                    loginWeb.goBack();
                } else {
                    hideLogin();
                }
                return true;
            }
            if (web != null && pageEverLoaded) {
                // Android drawer pattern: the first back closes the sidebar
                web.evaluateJavascript("(window.__dshBackAction&&window.__dshBackAction())||0",
                    new android.webkit.ValueCallback<String>() {
                        @Override public void onReceiveValue(String v) {
                            if (!"1".equals(String.valueOf(v).trim())) {
                                handleBackFallback();
                            }
                        }
                    });
                return true;
            }
            handleBackFallback();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void handleBackFallback() {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else if (Prefs.get(MainActivity.this, Prefs.BACK_SUSPEND, true)) {
                    moveTaskToBack(true);
                } else {
                    finish();
                }
            }
        });
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
