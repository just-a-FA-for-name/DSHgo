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
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Native-looking settings screen: connection / display / behavior / data / about. */
public class SettingsActivity extends Activity {

    private int BG, CARD, TEXT, DIM, ACCENT;
    private static final int DANGER = 0xFFFF6B6B;

    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ThemePalette tp = ThemePalette.get(this);
        BG = tp.bg;
        CARD = tp.bar;
        TEXT = tp.text;
        DIM = tp.dim;
        ACCENT = tp.accent;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
        ThemePalette.applySystemBars(getWindow(), BG, CARD);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setFitsSystemWindows(true);

        // ---- top bar ----
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(CARD);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        View back = iconView(R.drawable.ic_back);
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        bar.addView(back);
        TextView title = new TextView(this);
        title.setText("设置");
        title.setTextColor(TEXT);
        title.setTextSize(18);
        title.setPadding(dp(8), 0, 0, 0);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(12), dp(6), dp(12), dp(28));

        // ================= 连接 =================
        section(content, "连接");
        tapRow(content, "隧道登录状态", tunnelSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { tunnelDialog(); }
        });
        tapRow(content, "目标服务器", targetSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { pickTarget(); }
        });
        switchRow(content, "自动发现目标", "隧道接通后自动识别远程工作台",
            Prefs.get(this, Prefs.AUTO_DISCOVER, true), Prefs.AUTO_DISCOVER);
        tapRow(content, "重新发现目标", "清除已发现的地址并重新扫描", new View.OnClickListener() {
            @Override public void onClick(View v) { rediscover(); }
        });
        tapRow(content, "站点管理", sitesSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { siteManager(); }
        });
        switchRow(content, "站点小窗", "顶栏地球图标：弹窗查看本地页面/监控面板（默认关闭）",
            Prefs.get(this, Prefs.SITE_POPUP, false), Prefs.SITE_POPUP);
        tapRow(content, "ZCode 远程链接", zcodeSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { editZcodeUrl(); }
        });
        switchRow(content, "启动时自动加载", "打开 App 后自动连接并载入工作台",
            Prefs.get(this, Prefs.AUTO_LOAD, true), Prefs.AUTO_LOAD);
        tapRow(content, "连接诊断", "检测隧道、目标可达性与延迟", new View.OnClickListener() {
            @Override public void onClick(View v) { diagnose(); }
        });

        // ================= 显示 =================
        section(content, "显示");
        tapRow(content, "主题风格", themeSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { pickTheme(); }
        });
        if("fish".equals(tp.id)) {
            LinearLayout preview=rowBase();preview.setOrientation(LinearLayout.VERTICAL);preview.setGravity(Gravity.CENTER);
            ImageView art=new ImageView(this);art.setImageResource(R.drawable.fish_happy);art.setScaleType(ImageView.ScaleType.FIT_CENTER);
            preview.addView(art,new LinearLayout.LayoutParams(dp(160),dp(160)));
            TextView caption=new TextView(this);caption.setText("大肥鱼陪你远程办公 · 可随时切回原主题");caption.setTextColor(DIM);caption.setTextSize(12);preview.addView(caption);content.addView(preview);
        }
        tapRow(content, "网页缩放", Prefs.fontPct(this) + "%",
            new View.OnClickListener() {
                @Override public void onClick(View v) { pickFontScale(); }
            });
        tapRow(content, "屏幕方向", orientationSummary(), new View.OnClickListener() {
            @Override public void onClick(View v) { pickOrientation(); }
        });
        switchRow(content, "全屏沉浸模式", "隐藏系统状态栏，工作区更大",
            Prefs.get(this, Prefs.FULLSCREEN, false), Prefs.FULLSCREEN);
        switchRow(content, "屏幕常亮", "监控场景下不自动息屏",
            Prefs.get(this, Prefs.KEEP_SCREEN, true), Prefs.KEEP_SCREEN);
        switchRow(content, "窄屏自动收起侧边栏", "默认收起，点左上角图标展开；选择会话或点空白处后收起",
            Prefs.get(this, Prefs.AUTO_SIDEBAR, true), Prefs.AUTO_SIDEBAR);
        switchRow(content, "桌面版模式", "以桌面浏览器布局渲染（适合平板/大屏）",
            Prefs.get(this, Prefs.DESKTOP_UA, false), Prefs.DESKTOP_UA);

        // ================= 行为 =================
        section(content, "行为");
        switchRow(content, "返回键挂起应用", "返回键把应用挂到后台而不是退出，保持会话",
            Prefs.get(this, Prefs.BACK_SUSPEND, true), Prefs.BACK_SUSPEND);
        switchRow(content, "外部链接用系统浏览器", "App 内只打开本服务器的页面",
            Prefs.get(this, Prefs.EXT_LINKS, true), Prefs.EXT_LINKS);
        switchRow(content, "断线自动重连", "恢复连接，尽量保留当前页面和未发送草稿",
            Prefs.get(this, Prefs.AUTO_RECONNECT, true), Prefs.AUTO_RECONNECT);

        // ================= 数据 =================
        section(content, "数据");
        tapRow(content, "清除网页缓存", "释放存储空间，不影响登录状态", new View.OnClickListener() {
            @Override public void onClick(View v) { confirmClear(false); }
        });
        tapRow(content, "清除登录凭证", "退出登录并清空 Cookie（下次进入需重新授权）", new View.OnClickListener() {
            @Override public void onClick(View v) { confirmClear(true); }
        });

        section(content,"故障排查");
        switchRow(content,"本地诊断日志","免 root · 仅状态和错误码 · 循环保存，不记录聊天或连接地址",Prefs.get(this,Diagnostics.ENABLED,true),Diagnostics.ENABLED);
        tapRow(content,"导出诊断包","5G 连不上或上传失败后导出 ZIP，手动选择保存位置",v->{
            Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.setType("application/zip");save.addCategory(Intent.CATEGORY_OPENABLE);
            save.putExtra(Intent.EXTRA_TITLE,"DSHgo-diagnostics-"+new java.text.SimpleDateFormat("yyyyMMdd-HHmmss",java.util.Locale.ROOT).format(new java.util.Date())+".zip");
            try{startActivityForResult(save,2201);}catch(Exception e){Toast.makeText(this,"未找到文件保存应用",Toast.LENGTH_LONG).show();}
        });
        tapRow(content,"清除诊断日志","只清除本应用的状态日志",v->{Diagnostics.clear(this);Toast.makeText(this,"诊断日志已清除",Toast.LENGTH_SHORT).show();});
        // ================= 关于 =================
        section(content, "关于");
        content.addView(aboutCard());
        tapRow(content,"大肥鱼素材与许可","原作：上善无形 · 二次设计：ZipZipPipe · CC BY-NC-SA 4.0",v->
            dialog("素材署名与许可",null).setMessage("素材来自 fisharchive.cc。原作上善无形，DeepSeek 元素二次设计 ZipZipPipe；图片采用 CC BY-NC-SA 4.0，保留署名、非商业使用、相同方式共享。图片许可独立于 MIT 代码许可。").setPositiveButton("知道了",null).show());

        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request!=2201||result!=RESULT_OK||data==null||data.getData()==null)return;
        final Uri uri=data.getData();
        new Thread(()->{boolean success=false;
            try(java.io.OutputStream out=getContentResolver().openOutputStream(uri,"w")){if(out==null)throw new java.io.IOException();Diagnostics.export(this,out);success=true;}catch(Exception ignored){}
            final boolean ok=success;handler.post(()->Toast.makeText(this,ok?"诊断包已保存，可手动分享给开发者":"保存失败，请重新选择位置",Toast.LENGTH_LONG).show());
        },"dsh-diagnostic-export").start();
    }
    // ---------------------------------------------------------------- rows

    private void section(LinearLayout parent, String name) {
        TextView t = new TextView(this);
        t.setText(name);
        t.setTextColor(DIM);
        t.setTextSize(12.5f);
        t.setPadding(dp(14), dp(20), 0, dp(6));
        parent.addView(t);
    }

    private LinearLayout rowBase() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(CARD);
        bg.setCornerRadius(dp(12));
        row.setBackground(bg);
        row.setPadding(dp(16), dp(13), dp(16), dp(13));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        row.setLayoutParams(lp);
        return row;
    }

    private LinearLayout textStack(String title, String sub) {
        LinearLayout stack = new LinearLayout(this);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(TEXT);
        t.setTextSize(15.5f);
        stack.addView(t);
        if (!TextUtils.isEmpty(sub)) {
            TextView s = new TextView(this);
            s.setText(sub);
            s.setTextColor(DIM);
            s.setTextSize(12.5f);
            s.setPadding(0, dp(3), dp(12), 0);
            stack.addView(s);
        }
        return stack;
    }

    private void tapRow(LinearLayout parent, String title, String sub, View.OnClickListener click) {
        LinearLayout row = rowBase();
        row.setClickable(true);
        row.setOnClickListener(click);
        row.addView(textStack(title, sub));
        TextView arrow = new TextView(this);
        arrow.setText("›");
        arrow.setTextColor(DIM);
        arrow.setTextSize(20);
        arrow.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(arrow);
        parent.addView(row);
    }

    private void switchRow(LinearLayout parent, String title, String sub,
                           boolean checked, final String key) {
        LinearLayout row = rowBase();
        row.addView(textStack(title, sub));
        final Switch sw = new Switch(this);
        sw.setChecked(checked);
        sw.setShowText(false);
        sw.setContentDescription(title);
        row.setOnClickListener(v->sw.setChecked(!sw.isChecked()));
        sw.setOnCheckedChangeListener((btn, on) -> Prefs.get(this).edit().putBoolean(key, on).apply());
        row.addView(sw);
        parent.addView(row);
    }

    private LinearLayout aboutCard() {
        LinearLayout row = rowBase();
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(16), dp(18), dp(16), dp(18));

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.HORIZONTAL);
        brand.setGravity(Gravity.CENTER_VERTICAL);
        ImageView bili = new ImageView(this);
        bili.setImageResource(R.drawable.ic_bilibili);
        brand.addView(bili, new LinearLayout.LayoutParams(dp(26), dp(26)));
        ImageView avatar = new ImageView(this);
        avatar.setImageBitmap(circle(BitmapFactory.decodeResource(getResources(), R.drawable.avatar)));
        LinearLayout.LayoutParams al = new LinearLayout.LayoutParams(dp(34), dp(34));
        al.setMargins(dp(10), 0, dp(8), 0);
        brand.addView(avatar, al);
        TextView name = new TextView(this);
        name.setText("Fa2517");
        name.setTextColor(TEXT);
        name.setTextSize(16);
        brand.addView(name);
        row.addView(brand);

        TextView ver = new TextView(this);
        try{ver.setText("DSHgo  "+getPackageManager().getPackageInfo(getPackageName(),0).versionName);}catch(Exception ignored){ver.setText("DSHgo");}
        ver.setTextColor(DIM);
        ver.setTextSize(12.5f);
        ver.setPadding(0, dp(12), 0, 0);
        row.addView(ver);

        TextView open = new TextView(this);
        open.setText("本项目完全开源");
        open.setTextColor(DIM);
        open.setTextSize(12.5f);
        open.setPadding(0, dp(3), 0, 0);
        row.addView(open);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(14), 0, 0);
        TextView help = linkButton("使用帮助", ACCENT);
        help.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showHelp(); }
        });
        actions.addView(help);
        TextView site = linkButton("Bilibili", ACCENT);
        site.setPadding(dp(22), 0, 0, 0);
        site.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://space.bilibili.com/330037645")));
                } catch (Exception ignored) {}
            }
        });
        actions.addView(site);
        row.addView(actions);
        return row;
    }

    private TextView linkButton(String text, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(14);
        t.setClickable(true);
        return t;
    }

    private View iconView(int res) {
        ImageView iv = new ImageView(this);
        iv.setImageResource(res);
        iv.setColorFilter(TEXT, android.graphics.PorterDuff.Mode.SRC_IN);
        iv.setPadding(dp(16), dp(14), dp(16), dp(14));
        iv.setClickable(true);
        return iv;
    }

    // ------------------------------------------------------------- actions

    private void editServer() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(Prefs.serverUrl(this));
        input.setSelection(input.getText().length());
        LinearLayout wrap = new LinearLayout(this);
        wrap.setPadding(dp(24), dp(8), dp(24), 0);
        wrap.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog("服务器地址", wrap)
            .setPositiveButton("保存", (d, w) -> {
                String v = input.getText().toString().trim();
                if (v.isEmpty()) v = Prefs.DEFAULT_URL;
                if (!v.startsWith("http")) v = "https://" + v;
                if(!EndpointPolicy.allowsCleartext(v)){toast("公开服务器请使用 HTTPS，HTTP 仅用于 tailnet 或私有内网");return;}
                Prefs.get(this).edit().putString(Prefs.SERVER_URL, v)
                    .putString(Prefs.TARGET_MODE, "manual").apply();
                toast("已保存，返回后生效");
                recreate();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void pickFontScale() {
        final String[] labels = {"75%", "85%", "100%", "115%", "130%", "150%"};
        final int[] values = {75, 85, 100, 115, 130, 150};
        int checked = 2;
        for (int i = 0; i < values.length; i++) if (values[i] == Prefs.fontPct(this)) checked = i;
        dialog("网页缩放", null)
            .setSingleChoiceItems(labels, checked, (d, w) -> {
                Prefs.get(this).edit().putInt(Prefs.FONT_PCT, values[w]).apply();
                d.dismiss();
                recreate();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void confirmClear(final boolean credentials) {
        dialog(credentials ? "清除登录凭证" : "清除网页缓存",
                textBlock(credentials ? "将退出登录并清空 Cookie，下次进入需要重新授权。" : "将清空网页缓存，不影响登录状态。"))
            .setPositiveButton("确定", (d, w) -> {
                if (credentials) {
                    android.webkit.CookieManager.getInstance().removeAllCookies(null);
                    android.webkit.WebStorage.getInstance().deleteAllData();
                }
                try {
                    new android.webkit.WebView(this).clearCache(true);
                } catch (Exception ignored) {}
                getCacheDir().delete();
                toast(credentials ? "凭证已清除" : "缓存已清除");
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void diagnose() {
        toast("正在诊断…");
        final String target = Prefs.effectiveUrl(this);
        new Thread(new Runnable() {
            @Override public void run() {
                final boolean vpn = isVpnUp();
                long t0 = System.currentTimeMillis();
                boolean up = false;
                String detail = "尚未发现目标，请先自动发现或填写服务器地址";
                HttpURLConnection c = null;
                try {
                    if(!EndpointPolicy.allowsCleartext(target))throw new SecurityException("Public HTTP blocked; use HTTPS");
                    java.net.URL url = new URL(target);
                    java.net.InetAddress.getAllByName(url.getHost());
                    detail = "DNS 已解析，正在检查 HTTPS / 桥接";
                    c = (HttpURLConnection) url.openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(15000);
                    c.setInstanceFollowRedirects(false);
                    int code = c.getResponseCode();
                    Diagnostics.event(SettingsActivity.this,11,code,System.currentTimeMillis()-t0);
                    up = code >= 200 && code < 400;
                    detail = "DNS 解析成功；HTTP " + code + (code >= 500 ? "（电脑桥接或工作台未就绪）" : "");
                } catch(SecurityException e){
                    Diagnostics.event(SettingsActivity.this,11,-3,System.currentTimeMillis()-t0);
                    detail="公开地址需要 HTTPS；HTTP 仅支持显式配置的 tailnet 或内网目标";
                } catch (java.net.UnknownHostException e) {
                    Diagnostics.event(SettingsActivity.this,11,-2,System.currentTimeMillis()-t0);
                    detail = "DNS 解析失败：请重新连接 DSHgo 隧道，确认 MagicDNS 已启用";
                } catch (javax.net.ssl.SSLException e) {
                    Diagnostics.event(SettingsActivity.this,11,-11,System.currentTimeMillis()-t0);
                    detail = "TLS 校验或握手失败：请使用电脑的完整 .ts.net 域名，勿替换为 IP";
                } catch (Exception e) {
                    Diagnostics.event(SettingsActivity.this,11,-1,System.currentTimeMillis()-t0);
                    if (!target.isEmpty()) detail = "连接失败：" + e.getClass().getSimpleName();
                } finally { if (c != null) c.disconnect(); }
                final String diagnostic = detail;
                final long ms = System.currentTimeMillis() - t0;
                final boolean reachable = up;
                final String ts = tailscaleSummary();
                handler.post(new Runnable() {
                    @Override public void run() {
                        String body =
                            "Tailscale：" + ts + "\n" +
                            "加密隧道：" + (vpn ? "已连接" : "未连接") + "\n" +
                            "服务器：" + target + "\n" +
                            "目标可达：" + (reachable ? "是（" + ms + " ms）" : "否") + "\n" +
                            diagnostic + "\n\n" +
                            (reachable ? "一切就绪，返回即可使用。"
                                       : "不可达时请检查：① 电脑 DSH 是否运行且 dsh-phone-remote 插件已启用② DSHgo 内置隧道是否已连接。");
                        dialog("连接诊断", textBlock(body))
                            .setPositiveButton("好", null)
                            .show();
                    }
                });
            }
        }).start();
    }

    private String themeSummary() {
        return ThemePalette.NAMES[ThemePalette.indexOf(Prefs.get(this).getString(Prefs.THEME, "midnight"))];
    }

    private String orientationSummary() {
        String m = Prefs.get(this).getString(Prefs.ORIENTATION, "portrait");
        if ("landscape".equals(m)) return "横屏";
        if ("system".equals(m)) return "跟随系统（适合平板）";
        return "竖屏";
    }

    private void pickOrientation() {
        final String[] labels = {"竖屏（推荐）", "横屏", "跟随系统（适合平板）"};
        final String[] values = {"portrait", "landscape", "system"};
        String cur = Prefs.get(this).getString(Prefs.ORIENTATION, "portrait");
        int checked = 0;
        for (int i = 0; i < values.length; i++) if (values[i].equals(cur)) checked = i;
        dialog("屏幕方向", null)
            .setSingleChoiceItems(labels, checked, (d, w) -> {
                Prefs.get(this).edit().putString(Prefs.ORIENTATION, values[w]).apply();
                d.dismiss();
                recreate();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void pickTheme() {
        int cur = ThemePalette.indexOf(Prefs.get(this).getString(Prefs.THEME, "midnight"));
        dialog("主题风格", null)
            .setSingleChoiceItems(ThemePalette.NAMES, cur, (d, w) -> {
                Prefs.get(this).edit().putString(Prefs.THEME, ThemePalette.IDS[w]).apply();
                d.dismiss();
                recreate();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private String tunnelSummary() {
        try {
            Tunnel t = Tunnel.get(this);
            if (!t.isEngineUp()) return "内核启动中…";
            if (!t.isLoggedIn()) return "未登录（点按登录）";
            boolean vpnReady = android.net.VpnService.prepare(this) == null;
            return t.isRunning() ? "已连接 · 隧道运行中"
                : (vpnReady ? "已登录 · 隧道未运行" : "已登录 · 待授权");
        } catch (Exception e) {
            return "状态未知";
        }
    }

    private void tunnelDialog() {
        final Tunnel t = Tunnel.get(this);
        final boolean loggedIn = t.isLoggedIn();
        dialog("内置隧道", textBlock(loggedIn
                ? "已登录 Tailscale 账号，隧道由本 App 内核直接提供。\n\n如需更换账号可先退出登录。"
                : "尚未登录。登录一次即可，之后 App 打开自动建立隧道，无需任何其它应用。"))
            .setPositiveButton(loggedIn ? "退出登录" : "去登录", (d, w) -> {
                if (loggedIn) {
                    t.logout();
                    Prefs.get(this).edit().putString(Prefs.DISCOVERED_URL, "").apply();
                    recreate();
                    toast("已退出登录");
                } else {
                    startActivity(new Intent(this, MainActivity.class).putExtra("login", true));
                    finish();
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private String targetSummary() {
        String mode = Prefs.get(this).getString(Prefs.TARGET_MODE, "auto");
        if ("manual".equals(mode)) return "手动：" + Prefs.serverUrl(this);
        String found = Prefs.get(this).getString(Prefs.DISCOVERED_URL, "");
        return found.isEmpty() ? "自动发现（尚未发现）" : "自动：" + found;
    }

    private void pickTarget() {
        final String[] items = {"自动发现（推荐，万能抓取）", "手动输入地址"};
        dialog("目标服务器", null)
            .setItems(items, (d, w) -> {
                if (w == 0) {
                    Prefs.get(this).edit().putString(Prefs.TARGET_MODE, "auto").apply();
                    recreate();
                    toast("已切换为自动发现");
                } else {
                    editServer();
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private String sitesSummary() {
        int n = Prefs.getSites(this).length();
        return n == 0 ? "添加本地/远程网站（本地页面等），顶栏地球图标弹窗打开" : "已添加 " + n + " 个站点";
    }

    private String zcodeSummary() {
        String u = Prefs.get(this).getString(Prefs.ZCODE_URL, "");
        return (u == null || u.isEmpty()) ? "顶栏 ZCode go 直连使用（无需隧道）" : u;
    }

    private void editZcodeUrl() {
        LinearLayout lay = new LinearLayout(this);
        lay.setOrientation(LinearLayout.VERTICAL);
        lay.setPadding(dp(24), dp(8), dp(24), 0);
        final EditText url = new EditText(this);
        url.setHint("https://zcode.z.ai/remote/v4?sid=…");
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(Prefs.get(this).getString(Prefs.ZCODE_URL, ""));
        lay.addView(url, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog("ZCode 远程链接", lay)
            .setPositiveButton("保存", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    String u = url.getText().toString().trim();
                    if (!u.isEmpty() && !u.startsWith("http")) u = "https://" + u;
                    Prefs.get(SettingsActivity.this).edit().putString(Prefs.ZCODE_URL, u).apply();
                    recreate();
                    toast(u.isEmpty() ? "已清空" : "已保存，顶栏 ZCode go 直连");
                }
            })
            .setNeutralButton("清空", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    Prefs.get(SettingsActivity.this).edit().putString(Prefs.ZCODE_URL, "").apply();
                    recreate();
                    toast("已清空");
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void siteManager() {
        try {
            final org.json.JSONArray sites = Prefs.getSites(this);
            final java.util.ArrayList<String> labels = new java.util.ArrayList<>();
            for (int i = 0; i < sites.length(); i++) {
                org.json.JSONObject o = sites.optJSONObject(i);
                if (o != null) labels.add(o.optString("name", "站点") + "\n" + o.optString("url", ""));
            }
            AlertDialog.Builder b = dialog("站点管理", null);
            if (!labels.isEmpty()) {
                b.setItems(labels.toArray(new String[0]), new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, final int which) {
                        dialog("删除站点", textBlock("删除该站点？"))
                            .setPositiveButton("删除", new android.content.DialogInterface.OnClickListener() {
                                @Override public void onClick(android.content.DialogInterface d2, int w2) {
                                    sites.remove(which);
                                    Prefs.saveSites(SettingsActivity.this, sites);
                                    recreate();
                                    toast("已删除");
                                }
                            })
                            .setNegativeButton("取消", null)
                            .show();
                    }
                });
            }
            b.setPositiveButton("添加站点", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) { addSite(); }
            });
            b.setNegativeButton("关闭", null);
            b.show();
        } catch (Exception e) {
            toast("站点管理失败: " + e.getMessage());
        }
    }

    private void addSite() {
        LinearLayout lay = new LinearLayout(this);
        lay.setOrientation(LinearLayout.VERTICAL);
        lay.setPadding(dp(24), dp(8), dp(24), 0);
        final EditText name = new EditText(this);
        name.setHint("名称（如：监控面板）");
        final EditText url = new EditText(this);
        url.setHint("地址（https://… 或 https://…/__site/xxx.html）");
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        lay.addView(name, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        lay.addView(url, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog("添加站点", lay)
            .setPositiveButton("保存", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    String n = name.getText().toString().trim();
                    String u = url.getText().toString().trim();
                    if (n.isEmpty()) n = "站点";
                    if (u.isEmpty()) { toast("地址不能为空"); return; }
                    if (!u.startsWith("http")) u = "https://" + u;
                    org.json.JSONArray sites = Prefs.getSites(SettingsActivity.this);
                    try {
                        org.json.JSONObject o = new org.json.JSONObject();
                        o.put("name", n);
                        o.put("url", u);
                        sites.put(o);
                        Prefs.saveSites(SettingsActivity.this, sites);
                        recreate();
                        toast("已添加，顶栏地球图标可切换");
                    } catch (Exception e) {
                        toast("保存失败: " + e.getMessage());
                    }
                }
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void rediscover() {
        Prefs.get(this).edit()
            .putString(Prefs.DISCOVERED_URL, "")
            .putString(Prefs.TARGET_MODE, "auto")
            .apply();
        recreate();
        toast("已重置，回到主界面后重新扫描");
    }

    private String tailscaleSummary(){
        Tunnel tunnel=Tunnel.get(this);
        return tunnel.isEngineUp()?"内置引擎 · "+tunnel.backendState():"内置引擎未启动";
    }
    private void openTailscale(){
        Intent intent=new Intent(this,MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }

    private boolean isVpnUp() {
        android.net.ConnectivityManager cm =
            (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        android.net.Network n = cm.getActiveNetwork();
        if (n == null) return false;
        android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(n);
        return caps != null && caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
            && (android.os.Build.VERSION.SDK_INT < 29 || caps.getOwnerUid() == android.os.Process.myUid());
    }

    private void showHelp() {
        dialog("使用帮助", textBlock(HELP_TEXT))
            .setPositiveButton("好", null)
            .show();
    }

    // -------------------------------------------------------------- utils

    private AlertDialog.Builder dialog(String title, View custom) {
        AlertDialog.Builder b = new AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK);
        b.setTitle(title);
        if (custom != null) b.setView(custom);
        return b;
    }

    private View textBlock(String body) {
        TextView tv = new TextView(this);
        tv.setText(body);
        // dialogs always render on the dark theme: pin the text light or a
        // light app theme paints dark-on-dark (invisible help pages)
        tv.setTextColor(0xFFE8EAF2);
        tv.setTextSize(13.5f);
        tv.setLineSpacing(dp(4), 1f);
        ScrollView sc = new ScrollView(this);
        sc.setPadding(dp(24), dp(10), dp(24), 0);
        sc.addView(tv);
        return sc;
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

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    static final String HELP_TEXT =
        "【这是什么】\n" +
        "把电脑上的 DSH 工作台带到手机：点开 App 就是电脑上正在跑的实时会话，可看可操作。\n" +
        "隧道内核已内置在本 App 中，无需安装任何其它应用。\n\n" +
        "【首次使用】\n" +
        "1. 电脑：启动 DSH 桌面版，确认 dsh-phone-remote 插件已启用。\n" +
        "2. 手机：打开 DSH App → 点「登录账号」完成 Tailscale 登录（仅此一次）。\n" +
        "3. 系统会弹一次 VPN 授权确认 → 点允许。\n" +
        "   之后每次打开 App：隧道自动开启、自动发现电脑、自动进入工作台。\n\n" +
        "【日常使用】\n" +
        "· 顶栏 ≡ 开合侧边栏；⟳ 刷新；⚙ 进入设置。\n" +
        "· 返回键默认把 App 挂后台（会话不断），可在设置里改为退出。\n" +
        "· 状态点：绿=已连接，黄=连接中，红=断开（断开后自动重连）。\n\n" +
        "【常见问题】\n" +
        "· 一直“等待电脑端”：电脑未开机、DSH 未启动或远程插件未启用。\n" +
        "· 发现不到目标：设置 → 重新发现目标；或手动填地址。\n" +
        "· 换账号：设置 → 隧道登录状态 → 退出登录。\n" +
        "· 其它异常：设置 → 连接诊断，按提示排查。\n\n" +
        "【设置项说明】\n" +
        "连接：登录状态、目标服务器、自动发现、诊断。\n" +
        "显示：网页缩放、全屏、常亮、窄屏自动收起侧边栏、桌面版模式。\n" +
        "行为：返回键、外链处理、断线重连。\n" +
        "数据：清缓存、清凭证。\n" +
        "关于：版本、作者 Fa2517、开源说明。";
}
