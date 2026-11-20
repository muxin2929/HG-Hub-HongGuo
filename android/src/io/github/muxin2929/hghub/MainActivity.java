package io.github.muxin2929.hghub;

import android.animation.ObjectAnimator;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * HG短剧 Android 壳。
 *
 * 页面走 https://appassets.androidplatform.net/，由 shouldInterceptRequest 从
 * ① App 私有目录 www/（热更新后的版本）② assets/www（内置版本）读取，
 * 所以前端更新可以"App 内自己完成"：后台下载 www.zip → 解压替换 → 自动刷新，无需重装。
 */
public class MainActivity extends android.app.Activity {

    // 构建前把这里改成你自己的网关地址（必须 HTTPS），否则 App 启动后没有内容源。
    private static final String API_BASE = "https://your-domain.example";
    private static final String LOCAL_BASE = "https://appassets.androidplatform.net";
    private static final String LOCAL_HOST = "appassets.androidplatform.net";
    private static final String BUNDLED_WEB_VERSION = "1.5.46";

    private WebView web;
    private FrameLayout root;
    private HgPlayer hg;
    private HgTabBar tabbar;
    /** 网页希望 tabbar 显示吗；全屏期间临时隐藏，退出后按这个恢复 */
    private boolean tabbarWanted;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private File webRoot;
    /** 开屏层：冷启动到首帧之间盖住，同时让 WebView 在下面预热首页 */
    private View splash;
    private long splashAt;
    /** 写私有目录 www/ 时互斥：热更新下载与内置包落地不能同时改同一处 */
    private static final Object WWW_LOCK = new Object();
    /** 点了「立即安装」但还缺「安装未知应用」权限：从设置页回来要自动接着装 */
    private boolean pendingInstall;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        getWindow().setStatusBarColor(0x00000000);
        getWindow().setNavigationBarColor(0x00000000);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        // 原生播放层先铺进 root 最底层，WebView 后加 → 盖在它上面并保持透明
        hg = new HgPlayer(this, root);
        web = new WebView(this);
        web.setFitsSystemWindows(false);
        web.setBackgroundColor(0x00000000);
        // 关键：让 WebView 渲染到独立图层里再合成，透明像素才会真正透出下面的视频纹理。
        // 不加这个，WebView 某些机型上会被当成不透明的一层，原生画面就永远看不见。
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        hg.attachWeb(web);

        // 原生底部导航：盖在 WebView 上面，尺寸与网页 .tabbar 一致（54dp）。
        // 默认隐藏，由网页上报"该不该显示"，避免详情页/播放页多出一条导航。
        tabbar = new HgTabBar(this, key -> {
            if (web == null) return;
            web.evaluateJavascript("window.__hgTab&&window.__hgTab(\"" + key + "\")", null);
        });
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, tabbar.barHeight(),
                android.view.Gravity.BOTTOM);
        root.addView(tabbar, tlp);
        tabbar.setBarVisible(false);

        // 开屏：盖在从冷启动到首页首帧之间，免得先看到一片黑/白。
        // 这段时间 WebView 就在下面照常加载首页，等于顺手把首屏、第一条视频和封面都预热了。
        splashAt = SystemClock.elapsedRealtime();
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        new Handler(Looper.getMainLooper()).postDelayed(this::finishSplash, 3000); // 兜底，别一直盖着


        // 上次后台准备好的热更新（www_new）先换上：不在使用中删当前目录、也不 reload，
        // 这样启动公告/正在看的进度都不会被一次页面刷新打断。
        File staged = new File(getFilesDir(), "www_new");
        if (new File(staged, "index.html").isFile()) {
            File cur = new File(getFilesDir(), "www");
            deleteTree(cur);
            if (!staged.renameTo(cur)) deleteTree(staged);
        }

        // 有热更新过的页面就优先用私有目录里的；但内置包（随 APK 打包的前端）比它还新时，
        // 必须用内置的，否则重装新版本 APK 也还是旧界面。
        File hot = new File(getFilesDir(), "www");
        boolean hotOk = new File(hot, "index.html").isFile();
        String hotVer = hotOk ? readText(new File(hot, ".version")) : null;
        String assetVer = assetWebVersion();
        boolean bundledFresher = assetVer != null && (hotVer == null || newer(assetVer, hotVer));
        if (hotOk && !bundledFresher) webRoot = hot;
        if (bundledFresher) {
            // 本次会话直接用内置的最新页面，同一步把它落到私有目录，
            // 下次启动就不会再被旧的那份盖回去。
            new Thread(() -> installBundled(assetVer), "www-install").start();
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 系统字体调大时 WebView 会跟着放大（textZoom≠100），页面字变大、卡片标签被挤换行，
        // 和网页端完全不是一套字号。这里钉死 100：网页按几 px 设计，App 里就是几 px。
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " HGHubApp/1.5.46");
        // 视频交给原生 ExoPlayer，网页里的 MSE 只作为兜底
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // JS 桥：window.HGVideo
        web.addJavascriptInterface(hg, HgPlayer.BRIDGE);
        // 底部导航的状态由网页上报：选中项、深/浅、显不显示。
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void tab(String key, int dark) {
                runOnUiThread(() -> {
                    if (tabbar == null) return;
                    tabbar.setActive(key);
                    tabbar.setDarkMode(dark == 1);
                });
            }

            @android.webkit.JavascriptInterface
            public void tabs(int visible) {
                runOnUiThread(() -> {
                    if (tabbar == null) return;
                    tabbarWanted = visible == 1;
                    tabbar.setBarVisible(tabbarWanted && customView == null);
                });
            }

            /** 应用内下载新版本安装包（进度推给网页：window.__hgUpd） */
            @android.webkit.JavascriptInterface
            public void updateDownload(final String url) {
                new Thread(() -> {
                    File out = new File(getCacheDir(), "update.apk");
                    try {
                        //noinspection ResultOfMethodCallIgnored
                        if (out.exists()) out.delete();
                        boolean ok = fetchApk(url, out);
                        if (ok) {
                            pushUpd("{\"phase\":\"done\",\"total\":" + out.length() + "}");
                        } else {
                            pushUpd("{\"phase\":\"error\",\"msg\":\"下载失败，请检查网络\"}");
                        }
                    } catch (Exception e) {
                        pushUpd("{\"phase\":\"error\",\"msg\":\"" + esc(String.valueOf(e.getMessage())) + "\"}");
                    }
                }, "apk-update").start();
            }

            /** 拉起系统安装界面（装完不自动打开 App，交给用户） */
            @android.webkit.JavascriptInterface
            public void updateInstall() {
                runOnUiThread(() -> installApk());
            }

            @android.webkit.JavascriptInterface
            public String updateLocalVersion() {
                try {
                    return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                } catch (Exception e) {
                    return "";
                }
            }
        }, "HGShell");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            private boolean handleUrl(String url) {
                if (url.startsWith(LOCAL_BASE) || url.startsWith(API_BASE)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!LOCAL_HOST.equals(uri.getHost())) return null;
                String path = uri.getPath();
                if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
                try {
                    return new WebResourceResponse(mimeOf(path), "UTF-8", openAsset(path));
                } catch (IOException e) {
                    try {
                        return new WebResourceResponse("text/html", "UTF-8", openAsset("/index.html"));
                    } catch (IOException ignored) {
                        return null;
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame() && request.getUrl().toString().startsWith(LOCAL_BASE)) {
                    view.loadUrl(API_BASE + "/");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                finishSplash();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                root.addView(customView, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                if (tabbar != null) tabbar.setBarVisible(false);
                hideSystemBars();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (tabbar != null) tabbar.setBarVisible(tabbarWanted);
                if (customCallback != null) {
                    customCallback.onCustomViewHidden();
                    customCallback = null;
                }
            }
        });

        web.loadUrl(LOCAL_BASE + "/index.html");
        hideSystemBars();
        new Thread(this::checkWebUpdate, "web-update").start();
    }

    // ------------------------------------------------------------ 应用内更新

    /** 把进度推给网页：window.__hgUpd({phase,pct,bps,total}) */
    private void pushUpd(String json) {
        final String js = "window.__hgUpd&&window.__hgUpd(" + json + ")";
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", " ").replace("\"", " ").replace("\n", " ");
    }

    /** 带进度的下载（只用于更新包，几百 KB~几 MB，边下边报百分比） */
    private boolean fetchApk(String url, File out) throws IOException {
        HttpURLConnection c = null;
        InputStream in = null;
        FileOutputStream os = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != 200) return false;
            long total = c.getContentLengthLong();
            in = c.getInputStream();
            os = new FileOutputStream(out);
            byte[] buf = new byte[8192];
            long got = 0;
            long t0 = System.currentTimeMillis();
            long lastPush = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - lastPush > 220) {
                    lastPush = now;
                    double pct = total > 0 ? Math.min(99.0, got * 100.0 / total) : 0;
                    long bps = (now > t0) ? got * 1000 / Math.max(1, now - t0) : 0;
                    pushUpd(String.format(java.util.Locale.US,
                            "{\"phase\":\"progress\",\"pct\":%.1f,\"bps\":%d,\"total\":%d}", pct, bps, total));
                }
            }
            os.flush();
            return got > 100;
        } finally {
            try { if (os != null) os.close(); } catch (IOException ignored) { }
            try { if (in != null) in.close(); } catch (IOException ignored) { }
            if (c != null) c.disconnect();
        }
    }

    /** 拉起系统安装器；没有「安装未知应用」权限时先去设置页开，回来自动接着装 */
    private void installApk() {
        File apk = new File(getCacheDir(), "update.apk");
        if (!apk.isFile() || apk.length() < 100) {
            pushUpd("{\"phase\":\"error\",\"msg\":\"安装包不存在，请重新下载\"}");
            toastOn("安装包不存在，请重新下载更新");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            // 记一下：等用户从「安装未知应用」页回来，onResume 里自动再装一次
            pendingInstall = true;
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
                toastOn("请打开「允许安装未知应用」，回来后会自动开始安装");
            } catch (Exception e) {
                pendingInstall = false;
                toastOn("打不开权限设置页，请手动到 设置-应用-特殊权限 里允许安装");
            }
            return;
        }
        doLaunchInstaller(apk);
    }

    /** 真正调起系统安装界面（装完系统会发 MY_PACKAGE_REPLACED，由 UpdateReceiver 自动拉起 App） */
    private void doLaunchInstaller(File apk) {
        try {
            Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            // Android 10+ 有些 ROM 光靠 flag 授不过去，ClipData 里再带一份才稳
            i.setClipData(android.content.ClipData.newRawUri("apk", uri));
            startActivity(i);
        } catch (Throwable e) {
            String msg = String.valueOf(e.getMessage());
            pushUpd("{\"phase\":\"error\",\"msg\":\"" + esc(msg) + "\"}");
            toastOn("安装失败：" + msg);
        }
    }

    private void toastOn(String text) {
        runOnUiThread(() -> android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show());
    }

    // ------------------------------------------------------------ 开屏

    /** 开屏层：品牌字 + 一条来回跑的细进度条，纯代码画，不额外加资源 */
    private View buildSplash() {
        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(0xFF0B0B0F);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView logo = new TextView(this);
        logo.setText("HG");
        logo.setTextColor(0xFFFF3B4E);
        logo.setTextSize(34);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setLetterSpacing(0.14f);
        logo.setGravity(Gravity.CENTER);
        mid.addView(logo, new LinearLayout.LayoutParams(-2, -2));

        TextView sub = new TextView(this);
        sub.setText("短剧 · 每天都有新片");
        sub.setTextColor(0xFF8A8F98);
        sub.setTextSize(12);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(-2, -2);
        subLp.topMargin = dp(10);
        mid.addView(sub, subLp);

        FrameLayout.LayoutParams midLp = new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER);
        box.addView(mid, midLp);

        int trackW = dp(104);
        int trackH = dp(3);
        int barW = dp(36);
        View track = new View(this);
        GradientDrawable tg = new GradientDrawable();
        tg.setColor(0x1FFFFFFF);
        tg.setCornerRadius(dp(2));
        track.setBackground(tg);
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(trackW, trackH,
                Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM);
        tlp.bottomMargin = dp(92);
        box.addView(track, tlp);

        View bar = new View(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFFFF3B4E);
        bg.setCornerRadius(dp(2));
        bar.setBackground(bg);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(barW, trackH,
                Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM);
        blp.bottomMargin = dp(92);
        box.addView(bar, blp);

        float span = (trackW - barW) / 2f;
        bar.setTranslationX(-span);
        ObjectAnimator anim = ObjectAnimator.ofFloat(bar, "translationX", -span, span);
        anim.setDuration(900);
        anim.setRepeatMode(ObjectAnimator.REVERSE);
        anim.setRepeatCount(ObjectAnimator.INFINITE);
        anim.start();
        box.setTag(anim);
        return box;
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 首帧到了就淡出；但至少让它露 1.1 秒，别闪一下就没了 */
    private void finishSplash() {
        final View v = splash;
        if (v == null) return;
        splash = null;
        Runnable fade = () -> {
            Object tag = v.getTag();
            if (tag instanceof ObjectAnimator) ((ObjectAnimator) tag).cancel();
            v.animate().alpha(0f).setDuration(260).withEndAction(() -> root.removeView(v)).start();
        };
        long left = 1100 - (SystemClock.elapsedRealtime() - splashAt);
        if (left > 0) new Handler(Looper.getMainLooper()).postDelayed(fade, left);
        else fade.run();
    }

    // ------------------------------------------------------------ 前端热更新

    /** 当前生效的前端版本：私有目录里的优先，没有就用内置包版本 */
    private String localWebVersion() {
        File hot = new File(getFilesDir(), "www");
        if (new File(hot, "index.html").isFile()) {
            String v = readText(new File(hot, ".version"));
            if (v != null) return v;
            // 早期热更新没写 .version：内容不可信，当作最旧，允许被远端覆盖
            return "0.0.0";
        }
        return BUNDLED_WEB_VERSION;
    }

    private String assetWebVersion() {
        try (InputStream in = getAssets().open("www/version.txt")) {
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            String v = r.readLine();
            return v == null || v.trim().isEmpty() ? null : v.trim();
        } catch (IOException e) {
            return BUNDLED_WEB_VERSION;
        }
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"))) {
            String v = r.readLine();
            return v == null || v.trim().isEmpty() ? null : v.trim();
        } catch (IOException e) {
            return null;
        }
    }

    /** 把随包内置的前端整份落到私有目录 www/，并写上版本号 */
    private void installBundled(String ver) {
        File target = new File(getFilesDir(), "www");
        File staging = new File(getFilesDir(), "www_new");
        try {
            synchronized (WWW_LOCK) {
                deleteTree(staging);
                copyAssetDir("www", staging);
                if (!new File(staging, "index.html").isFile()) return;
                try (FileOutputStream out = new FileOutputStream(new File(staging, ".version"))) {
                    out.write(ver.getBytes("UTF-8"));
                }
                deleteTree(target);
                if (!staging.renameTo(target)) {
                    // rename 失败：私有目录已清空，下次启动会自动回落到内置包
                    return;
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void copyAssetDir(String assetPath, File dest) throws IOException {
        String[] kids = getAssets().list(assetPath);
        if (kids == null || kids.length == 0) return;
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("mkdirs " + dest);
        for (String k : kids) {
            String child = assetPath + "/" + k;
            String[] grand = getAssets().list(child);
            File out = new File(dest, k);
            if (grand != null && grand.length > 0) {
                copyAssetDir(child, out);
                continue;
            }
            try (InputStream in = getAssets().open(child); FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            }
        }
    }

    private void checkWebUpdate() {
        try {
            String json = httpGet(API_BASE + "/api/app/web-version");
            if (json == null) return;
            String remote = between(json, "\"version\"", "\"");
            if (remote == null || !newer(remote, localWebVersion())) return;

            File tmpZip = new File(getCacheDir(), "www.zip");
            if (!download(API_BASE + "/app/www.zip", tmpZip)) return;

            File staging = new File(getFilesDir(), "www_new");
            synchronized (WWW_LOCK) {
                deleteTree(staging);
                if (!unzip(tmpZip, staging)) return;
                if (!new File(staging, "index.html").isFile()) return;
                try (FileOutputStream out = new FileOutputStream(new File(staging, ".version"))) {
                    out.write(remote.getBytes("UTF-8"));
                }
                // 只准备，不替换、不刷新：正在跑的这一份继续用，
                // 下次冷启动由 onCreate 把 www_new 换上去。
            }
            tmpZip.delete();
        } catch (Exception ignored) {
        }
    }

    private static int[] semver(String v) {
        String[] p = v.split("\\.");
        int[] r = new int[3];
        for (int i = 0; i < 3 && i < p.length; i++) {
            try {
                r[i] = Integer.parseInt(p[i].replaceAll("[^0-9]", ""));
            } catch (Exception ignored) {
            }
        }
        return r;
    }

    /** 远端版本比本地新才更新（避免服务器版本号回退时把 App 降级） */
    private static boolean newer(String remote, String local) {
        int[] a = semver(remote), b = semver(local);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) return a[i] > b[i];
        }
        return false;
    }

    private static String between(String json, String key, String quote) {
        int k = json.indexOf(key);
        if (k < 0) return null;
        int a = json.indexOf(quote, k + key.length());
        if (a < 0) return null;
        int b = json.indexOf(quote, a + 1);
        if (b < 0) return null;
        return json.substring(a + 1, b);
    }

    private String httpGet(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private boolean download(String url, File out) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() != 200) return false;
            try (InputStream in = c.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            }
            return out.length() > 1000;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean unzip(File zip, File dir) {
        try (ZipInputStream zis = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[16384];
            while ((e = zis.getNextEntry()) != null) {
                String name = e.getName();
                if (name.contains("..")) continue;
                File f = new File(dir, name);
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    f.mkdirs();
                    continue;
                }
                File parent = f.getParentFile();
                if (parent != null) //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private InputStream openAsset(String path) throws IOException {
        if (webRoot != null) {
            File f = new File(webRoot, path);
            if (f.isFile()) return new FileInputStream(f);
        }
        return getAssets().open("www" + path);
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        }
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            if (web != null) {
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
            }
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (hg != null) hg.onPause();
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (hg != null) hg.onResume();
        // 刚从「安装未知应用」设置页回来：权限开了就自动接着装
        if (pendingInstall) {
            pendingInstall = false;
            if (Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls()) {
                File apk = new File(getCacheDir(), "update.apk");
                if (apk.isFile() && apk.length() > 100) {
                    runOnUiThread(() -> doLaunchInstaller(apk));
                }
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (hg != null) {
            hg.onDestroy();
            hg = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
