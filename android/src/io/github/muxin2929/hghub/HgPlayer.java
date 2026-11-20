package io.github.muxin2929.hghub;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;

/**
 * 原生播放器：ExoPlayer + TextureView。
 *
 * 布局是「原生纹理在最底层，透明 WebView 盖在上面」：
 *   root(FrameLayout, 黑底)
 *     ├─ box(FrameLayout, clipChildren)   ← 网页传来的视频矩形，只决定显示范围
 *     │    └─ TextureView                 ← ExoPlayer 渲染面（按 contain/cover/fill 自己算内框）
 *     └─ WebView                          ← 页面/浮层 UI，视频区域透明
 *
 * 对 JS 暴露的接口就是 HGVideo 这一套，语义对齐 <video>：
 *   open(uri,start,rate,muted) / play / pause / seek / speed / mute / stop
 *   rect(x,y,w,h,fit)           网页占位元素的像素矩形（CSS px × devicePixelRatio）
 *   visible(0/1) / awake(0/1)
 * 状态回推统一走 window.__hgNative(json)，ev = time/ready/size/ended/state/error。
 */
public class HgPlayer {

    /** 桥接对象名：网页里读 window.HGVideo 判断是否处于原生模式 */
    public static final String BRIDGE = "HGVideo";

    private static final int FIT_CONTAIN = 0;
    private static final int FIT_COVER = 1;
    private static final int FIT_FILL = 2;

    private final Context ctx;
    private final FrameLayout root;
    private final FrameLayout box;
    private final TextureView tv;
    private WebView web;

    private ExoPlayer player;
    private Surface surface;

    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            pushTime();
            // 兜底揭幕：换流超时了也把帘子拉开，别让「黑屏但进度条在动」复现
            if (revealAt > 0 && android.os.SystemClock.uptimeMillis() >= revealAt && tv.getAlpha() < 1f) {
                applyLayout();
            }
            if (++tickN % 5 == 0) pushDbg();
            h.postDelayed(this, 200);
        }
    };
    private int tickN = 0;

    private String uri = "";
    private int rectX, rectY, rectW, rectH;
    private int fit = FIT_CONTAIN;
    private int vw, vh;
    private boolean muted = true;
    private float rate = 1f;
    private boolean visible = true;
    private boolean wantPlay = false;
    /** 诊断用：TextureView 是否真的拿到了 SurfaceTexture */
    private boolean surfaced = false;
    /** 当前这条流的画面是否已经渲染出来（换流期间为 false，整层遮住） */
    private boolean firstFrame = false;
    /** 换流时先挡住旧画面，但最多挡 900ms：万一首帧回调不来也不能一直黑 */
    private long revealAt = 0;
    private String lastError = "";

    // ------------------------------------------------------------ 预览帧解码器（独立于主播放器）
    // 拖动进度条时既不能拿主播放器去 seek（画面会停住、解码器重建，就是「卡一下」的来源），
    // 也不能只抓当前画面（预览就永远是同一张）。所以单开一路：
    // 自己的 ExoPlayer + 自己的离屏 TextureView，seek 到目标时间再抓位图。
    private FrameLayout grabBox;
    private TextureView grabTv;
    private ExoPlayer grabPlayer;
    private Surface grabSurface;
    private String grabUri = "";
    private double grabTarget = -1;
    private boolean grabBusy = false;

    public HgPlayer(Context ctx, FrameLayout root) {
        this.ctx = ctx;
        this.root = root;

        box = new FrameLayout(ctx);
        box.setClipChildren(true);
        box.setClipToPadding(true);
        box.setBackgroundColor(0x00000000);
        // 先铺满：保证 TextureView 一开始就挂在窗口上、能拿到 SurfaceTexture，
        // 真正的取景矩形等网页传 rect() 再收窄
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 整层常驻可见：TextureView 必须一直在窗口上，SurfaceTexture 才分配得出来。
        // 露不露脸由 applyLayout 里的 tv alpha 帘子控制（INVISIBLE 会造成首帧永不回调的黑屏死锁）
        box.setVisibility(View.VISIBLE);

        tv = new TextureView(ctx);
        tv.setOpaque(false);
        box.addView(tv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        tv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
                surfaced = true;
                releaseSurface();
                surface = new Surface(st);
                if (player != null) player.setVideoSurface(surface);
                applyLayout();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {
                surfaced = true;
                applyLayout();
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
                releaseSurface();
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture st) {
            }
        });

        player = buildPlayer();

        // 预览帧用的离屏渲染面：放在最底层、1% 透明，平时被主画面完全盖住，看不见
        grabBox = new FrameLayout(ctx);
        grabBox.setAlpha(0.01f);
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(160, 92);
        root.addView(grabBox, 0, glp);
        grabTv = new TextureView(ctx);
        grabBox.addView(grabTv, new FrameLayout.LayoutParams(160, 92));
        grabTv.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h2) {
                releaseGrabSurface();
                grabSurface = new Surface(st);
                if (grabPlayer != null) grabPlayer.setVideoSurface(grabSurface);
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h2) {
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
                releaseGrabSurface();
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture st) {
            }
        });
    }

    public void attachWeb(WebView w) {
        this.web = w;
    }

    // ------------------------------------------------------------ ExoPlayer

    private ExoPlayer buildPlayer() {
        // 拖完进度条是跳到任意位置，必须重新取分片：把起播门槛压到 350ms，
        // 跳过去尽快出画面（默认 500ms，加上更长的 min 缓冲，看着就是「停一下」）
        androidx.media3.exoplayer.DefaultLoadControl lc =
                new androidx.media3.exoplayer.DefaultLoadControl.Builder()
                        .setBufferDurationsMs(10_000, 30_000, 350, 600)
                        .build();
        ExoPlayer p = new ExoPlayer.Builder(ctx).setLoadControl(lc).build();
        p.setAudioAttributes(
                new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true);
        p.setVolume(muted ? 0f : 1f);
        p.setPlaybackSpeed(rate);
        if (surface != null) p.setVideoSurface(surface);
        p.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    pushReady();
                    pushSize();
                } else if (state == Player.STATE_ENDED) {
                    wantPlay = false;
                    push("{\"ev\":\"ended\"}");
                    pushState();
                } else if (state == Player.STATE_BUFFERING) {
                    pushState();
                }
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                pushState();
            }

            @Override
            public void onVideoSizeChanged(VideoSize size) {
                // 旋转 90/270 的片子：宽高要对调，否则版式算反
                int deg = size.unappliedRotationDegrees;
                if (deg == 90 || deg == 270) {
                    vw = size.height;
                    vh = size.width;
                } else {
                    vw = size.width;
                    vh = size.height;
                }
                applyLayout();
                pushSize();
            }

            @Override
            public void onRenderedFirstFrame() {
                // 新片子真的出第一帧了才露脸：换流期间整块遮住，
                // 免得观众看到上一条流的内容在新画幅里跳一下
                firstFrame = true;
                applyLayout();
                // 告诉网页「画面真的出来了」，它这时候才撤封面垫层
                push("{\"ev\":\"ff\"}");
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                lastError = error.getErrorCodeName();
                StringBuilder sb = new StringBuilder(lastError);
                String cause = "";
                Throwable t = error.getCause();
                if (t != null) cause = String.valueOf(t.getMessage());
                if (cause.isEmpty()) cause = String.valueOf(error.getMessage());
                if (cause.length() > 0) sb.append(" | ").append(cause);
                push("{\"ev\":\"error\",\"msg\":" + js(sb.toString()) + "}");
            }
        });
        return p;
    }

    private void releaseSurface() {
        if (player != null) player.clearVideoSurface();
        if (surface != null) {
            surface.release();
            surface = null;
        }
    }

    // ------------------------------------------------------------ 布局

    private void applyLayout() {
        // 「尺寸已知 + 该露脸」才把画面露出来；首帧只是用来压住换流的空档。
        // 关键：整层 box 永远是 VISIBLE，只用 tv 的 alpha 当帘子。
        // 之前用 box.setVisibility(INVISIBLE) 会挡住 SurfaceTexture 的分配 → 首帧永远不来 → 全黑死锁；
        // 而且换成 alpha 帘子后，换剧时旧纹理不会带着旧画面被拉到新矩形上（那正是「残留 + 拉伸」）。
        boolean timedOut = revealAt > 0 && android.os.SystemClock.uptimeMillis() >= revealAt;
        boolean sized = vw > 0 && vh > 0;
        // 尺寸没拿到之前绝不露：这时内框被铺成整块矩形，TextureView 里还挂着上一条流的
        // 最后一帧，一露就是「上一个视频的一帧被拉伸铺满全屏」。宁可多等，封面垫着。
        boolean ready = sized && (firstFrame || timedOut);
        box.setVisibility(View.VISIBLE);
        tv.setAlpha(visible && ready ? 1f : 0f);
        if (rectW <= 0 || rectH <= 0) {
            setInner(0, 0, box.getWidth(), box.getHeight());
            return;
        }
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(rectW, rectH);
        blp.leftMargin = rectX;
        blp.topMargin = rectY;
        box.setLayoutParams(blp);

        int w = rectW, hgt = rectH;
        if (vw <= 0 || vh <= 0) {
            // 还不知道片子尺寸：先铺满，等 onVideoSizeChanged 再纠
            setInner(0, 0, w, hgt);
            return;
        }
        double s;
        if (fit == FIT_COVER) {
            s = Math.max((double) w / vw, (double) hgt / vh);
        } else if (fit == FIT_FILL) {
            setInner(0, 0, w, hgt);
            return;
        } else {
            s = Math.min((double) w / vw, (double) hgt / vh);
        }
        int iw = (int) Math.round(vw * s);
        int ih = (int) Math.round(vh * s);
        setInner((w - iw) / 2, (hgt - ih) / 2, iw, ih);
    }

    private void setInner(int x, int y, int w, int hgt) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, hgt);
        lp.leftMargin = x;
        lp.topMargin = y;
        tv.setLayoutParams(lp);
    }

    // ------------------------------------------------------------ 状态回推

    private void pushTime() {
        if (player == null) return;
        long d = player.getDuration();
        double dur = d == C.TIME_UNSET ? 0 : d / 1000.0;
        double t = player.getCurrentPosition() / 1000.0;
        boolean playing = player.isPlaying();
        boolean buffering = player.getPlaybackState() == Player.STATE_BUFFERING;
        push("{\"ev\":\"time\",\"t\":" + t + ",\"d\":" + dur + ",\"p\":" + playing + ",\"b\":" + buffering + "}");
    }

    private void pushReady() {
        long d = player == null ? 0 : player.getDuration();
        double dur = d == C.TIME_UNSET ? 0 : d / 1000.0;
        push("{\"ev\":\"ready\",\"d\":" + dur + "}");
    }

    private void pushSize() {
        if (vw <= 0 || vh <= 0) return;
        push("{\"ev\":\"size\",\"w\":" + vw + ",\"h\":" + vh + "}");
    }

    private void pushState() {
        if (player == null) return;
        boolean playing = player.isPlaying();
        boolean buffering = player.getPlaybackState() == Player.STATE_BUFFERING;
        boolean ended = player.getPlaybackState() == Player.STATE_ENDED;
        push("{\"ev\":\"state\",\"p\":" + playing + ",\"b\":" + buffering + ",\"e\":" + ended + "}");
    }

    /** 诊断：每 tick 回推一次原生层的真实状态，前端左上角小字展示 */
    private void pushDbg() {
        if (uri == null || uri.isEmpty()) return;
        long d = player == null ? 0 : player.getDuration();
        double dur = d == C.TIME_UNSET ? 0 : d / 1000.0;
        double t = player == null ? 0 : player.getCurrentPosition() / 1000.0;
        int st = player == null ? -9 : player.getPlaybackState();
        push("{\"ev\":\"dbg\",\"s\":" + (surfaced ? 1 : 0) + ",\"st\":" + st
                + ",\"a\":" + tv.getAlpha()
                + ",\"w\":" + vw + ",\"h\":" + vh
                + ",\"t\":" + t + ",\"d\":" + dur
                + ",\"p\":" + (player != null && player.isPlaying())
                + ",\"r\":\"" + rectX + "," + rectY + "," + rectW + "," + rectH + "\""
                + ",\"tv\":\"" + tv.getWidth() + "x" + tv.getHeight() + "\""
                + ",\"vis\":" + (box.getVisibility() == View.VISIBLE ? 1 : 0)
                + ",\"l\":" + luma()
                + ",\"e\":" + js(lastError) + "}");
    }

    /** 纹理里到底有没有画面：采样 24×24 的平均亮度，-1 表示取不到 */
    private double luma() {
        android.graphics.Bitmap bm = null;
        try {
            if (!tv.isAvailable() || tv.getWidth() <= 0 || tv.getHeight() <= 0) return -1;
            bm = tv.getBitmap(24, 24);
            if (bm == null) return -1;
            int w = bm.getWidth(), hgt = bm.getHeight();
            int[] px = new int[w * hgt];
            bm.getPixels(px, 0, w, 0, 0, w, hgt);
            long sum = 0;
            for (int p : px) {
                int r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
                sum += (r + g + b) / 3;
            }
            return Math.round((double) sum / px.length);
        } catch (Throwable ignored) {
            return -1;
        } finally {
            if (bm != null) bm.recycle();
        }
    }

    private void push(String json) {
        final WebView w = web;
        if (w == null) return;
        final String js = "window.__hgNative&&window.__hgNative('" + json.replace("\\", "\\\\").replace("'", "\\'") + "')";
        h.post(() -> w.evaluateJavascript(js, null));
    }

    private static String js(String s) {
        if (s == null) return "\"\"";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private void startTicker() {
        h.removeCallbacks(ticker);
        h.post(ticker);
    }

    private void stopTicker() {
        h.removeCallbacks(ticker);
    }

    // ------------------------------------------------------------ 生命周期（MainActivity 调）

    public void onPause() {
        if (player != null && wantPlay) {
            player.pause();
            wantPlay = true; // 记住"本来在播"，回来接着播
        }
        stopTicker();
    }

    public void onResume() {
        if (player != null && wantPlay) player.play();
        if (uri != null && !uri.isEmpty()) startTicker();
    }

    public void onDestroy() {
        stopTicker();
        if (player != null) {
            try {
                player.release();
            } catch (Throwable ignored) {
            }
            player = null;
        }
        releaseSurface();
    }

    // ------------------------------------------------------------ JS 桥

    /** 设备解码能力：决定网页敢不敢直接上 HEVC 1080P 那条流 */
    @JavascriptInterface
    public String caps() {
        boolean hevc = false, hevc1080 = false;
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
            for (MediaCodecInfo info : list.getCodecInfos()) {
                if (info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    if (!"video/hevc".equalsIgnoreCase(type) && !"video/h265".equalsIgnoreCase(type)) continue;
                    hevc = true;
                    try {
                        MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
                        if (caps.getVideoCapabilities() != null
                                && caps.getVideoCapabilities().isSizeSupported(1080, 1920)
                                && caps.getVideoCapabilities().isSizeSupported(1920, 1080)) {
                            hevc1080 = true;
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return "{\"hevc\":" + hevc + ",\"hevc1080\":" + hevc1080
                + ",\"sdk\":" + Build.VERSION.SDK_INT
                + ",\"model\":" + js(Build.MODEL) + "}";
    }

    @JavascriptInterface
    public void open(String newUri, double start, double rate, int muted2) {
        this.rate = (float) (rate <= 0 ? 1 : rate);
        this.muted = muted2 == 1;
        final String u = newUri == null ? "" : newUri.trim();
        if (u.isEmpty()) return;
        final long pos = (long) (Math.max(0, start) * 1000);
        h.post(() -> {
            if (player == null) return;
            // 换流：先把整层收起来，等新流第一帧渲染完成再露；
            // 同一条流重新 open（比如播放页借回首页）就别闪了
            final boolean sameStream = u.equals(uri);
            uri = u;
            visible = true;
            if (!sameStream) {
                firstFrame = false;
                revealAt = android.os.SystemClock.uptimeMillis() + 900;
                vw = 0;
                vh = 0;
                // 立刻把帘子拉上：这一刻 TextureView 里还是上一条流的最后一帧，
                // 不挡住的话它会被新矩形拉成「上一个视频的残影」
                tv.setAlpha(0f);
                setInner(0, 0, Math.max(1, rectW), Math.max(1, rectH));
            } else {
                revealAt = 0;
            }
            wantPlay = true;
            lastError = "";
            // 万一 SurfaceTexture 比播放器先到/后到，这里兜一次
            if (surface == null && tv.isAvailable() && tv.getSurfaceTexture() != null) {
                surfaced = true;
                surface = new Surface(tv.getSurfaceTexture());
                player.setVideoSurface(surface);
            }
            try {
                player.stop();
                player.clearMediaItems();
                HlsMediaSource ms = new HlsMediaSource.Factory(new DefaultDataSource.Factory(ctx))
                        .setAllowChunklessPreparation(true)
                        .createMediaSource(MediaItem.fromUri(u));
                player.setVolume(this.muted ? 0f : 1f);
                player.setPlaybackSpeed(this.rate);
                player.setMediaSource(ms, pos);
                player.prepare();
                player.setPlayWhenReady(true);
            } catch (Throwable t) {
                push("{\"ev\":\"error\",\"msg\":" + js(String.valueOf(t.getMessage())) + "}");
            }
            applyLayout();
            startTicker();
        });
    }

    @JavascriptInterface
    public void play() {
        h.post(() -> {
            if (player == null) return;
            wantPlay = true;
            player.setPlayWhenReady(true);
            startTicker();
        });
    }

    @JavascriptInterface
    public void pause() {
        h.post(() -> {
            if (player == null) return;
            wantPlay = false;
            player.setPlayWhenReady(false);
        });
    }

    @JavascriptInterface
    public void seek(double t) {
        final long pos = (long) (Math.max(0, t) * 1000);
        h.post(() -> {
            if (player != null) player.seekTo(pos);
        });
    }

    /**
     * 抓一帧给网页做「拖进度条预览」。
     *
     * 关键点（这就是之前「预览永远同一张」的根因）：老实现只等主播放器自己走到 t 再抓，
     * 而拖动过程中主播放器根本没在走 —— 于是抓到的永远是当前那一帧。
     * 现在改成用独立的 grabPlayer 真 seek 到 t，等它 READY 且落到位置再抓位图。
     */
    @JavascriptInterface
    public void grab(double t) {
        grabTarget = Math.max(0, t);
        if (grabBusy) return; // 正在抓：这一轮完成后会自动追最新目标
        h.post(this::grabStep);
    }

    private void grabStep() {
        if (uri.isEmpty() || grabTarget < 0) return;
        if (grabPlayer == null) {
            ExoPlayer gp = new ExoPlayer.Builder(ctx).build();
            gp.setVolume(0f);
            gp.setPlayWhenReady(false);
            if (grabSurface != null) gp.setVideoSurface(grabSurface);
            grabPlayer = gp;
        }
        if (!uri.equals(grabUri)) {
            grabUri = uri;
            try {
                grabPlayer.stop();
                grabPlayer.clearMediaItems();
                HlsMediaSource ms = new HlsMediaSource.Factory(new DefaultDataSource.Factory(ctx))
                        .setAllowChunklessPreparation(true)
                        .createMediaSource(MediaItem.fromUri(uri));
                grabPlayer.setMediaSource(ms);
                grabPlayer.prepare();
                grabPlayer.setPlayWhenReady(false);
            } catch (Throwable ignored) {
            }
        }
        final double want = grabTarget;
        grabBusy = true;
        try {
            grabPlayer.seekTo((long) (want * 1000));
        } catch (Throwable ignored) {
        }
        grabPoll(want, 0);
    }

    private void grabPoll(final double want, final int n) {
        h.postDelayed(() -> {
            if (grabPlayer == null) {
                grabBusy = false;
                return;
            }
            // 手指已经拖到别处：这次作废，立刻追最新位置（预览必须跟着手指走）
            if (n > 0 && grabTarget >= 0 && Math.abs(grabTarget - want) > 0.4) {
                grabBusy = false;
                grabStep();
                return;
            }
            boolean ready = grabPlayer.getPlaybackState() == Player.STATE_READY;
            double pos = grabPlayer.getCurrentPosition() / 1000.0;
            // 容差给宽一点（±1.2s）：预览缩略图差一秒看不出来，但卡太死会永远抓不到、前端一直黑
            if (!ready || Math.abs(pos - want) > 1.2) {
                if (n < 20) {
                    grabPoll(want, n + 1);
                    return;
                }
                // 等太久了：已经开着画面就先给一张，别让用户一直对着黑预览
                if (!ready && !grabTv.isAvailable()) {
                    grabBusy = false;
                    return;
                }
            }
            grabBusy = false;
            android.graphics.Bitmap bm = null;
            try {
                if (!grabTv.isAvailable()) return;
                bm = grabTv.getBitmap(192, 108);
                if (bm == null) return;
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(8192);
                bm.compress(android.graphics.Bitmap.CompressFormat.JPEG, 58, bos);
                String b64 = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
                push("{\"ev\":\"frame\",\"t\":" + want + ",\"d\":\"data:image/jpeg;base64," + b64 + "\"}");
            } catch (Throwable ignored) {
            } finally {
                if (bm != null) bm.recycle();
            }
            // 还有没追上的目标：接着抓
            if (grabTarget >= 0 && Math.abs(grabTarget - want) > 0.4) grabStep();
        }, 110);
    }

    private void releaseGrabSurface() {
        if (grabSurface != null) {
            try {
                grabSurface.release();
            } catch (Throwable ignored) {
            }
            grabSurface = null;
        }
    }

    @JavascriptInterface
    public void speed(double r) {
        this.rate = (float) (r <= 0 ? 1 : r);
        h.post(() -> {
            if (player != null) player.setPlaybackSpeed(this.rate);
        });
    }

    @JavascriptInterface
    public void mute(int m) {
        this.muted = m == 1;
        h.post(() -> {
            if (player != null) player.setVolume(this.muted ? 0f : 1f);
        });
    }

    @JavascriptInterface
    public void stop() {
        h.post(() -> {
            stopTicker();
            wantPlay = false;
            uri = "";
            firstFrame = false;
            vw = 0;
            vh = 0;
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            if (grabPlayer != null) {
                grabPlayer.stop();
                grabPlayer.clearMediaItems();
            }
            grabUri = "";
            grabBusy = false;
            // 停掉以后不留旧帧：只是把帘子拉上，整层仍然留在窗口上
            tv.setAlpha(0f);
            setAwake(false);
        });
    }

    @JavascriptInterface
    public void rect(int x, int y, int w, int h2, int f) {
        h.post(() -> {
            rectX = x;
            rectY = y;
            rectW = Math.max(0, w);
            rectH = Math.max(0, h2);
            fit = f;
            applyLayout();
        });
    }

    @JavascriptInterface
    public void visible(int v) {
        h.post(() -> {
            visible = v == 1;
            // 露脸不能只靠首帧回调：没见过第一帧又没设过超时的话，这里补一个
            if (visible && !firstFrame && revealAt <= 0) {
                revealAt = android.os.SystemClock.uptimeMillis() + 500;
            }
            applyLayout();
        });
    }

    @JavascriptInterface
    public void awake(int on) {
        h.post(() -> setAwake(on == 1));
    }

    /**
     * mode: 1 = 横屏（全屏页），2 = 竖屏，0 = 交回传感器。
     * 原生画面没法跟着 Web 的 CSS 旋转走，只能靠真的转屏；
     * Activity 已声明 configChanges，转屏不会重建，WebView 里的状态全都留着。
     */
    @JavascriptInterface
    public void orient(int mode) {
        h.post(() -> {
            try {
                if (!(ctx instanceof android.app.Activity)) return;
                android.app.Activity a = (android.app.Activity) ctx;
                if (mode == 1) {
                    a.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                } else if (mode == 2) {
                    a.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                } else {
                    a.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                }
                // 转屏后布局变了，矩形要重算
                h.postDelayed(this::applyLayout, 260);
            } catch (Throwable ignored) {
            }
        });
    }

    private void setAwake(boolean on) {
        try {
            if (ctx instanceof android.app.Activity) {
                android.app.Activity a = (android.app.Activity) ctx;
                if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        } catch (Throwable ignored) {
        }
    }
}
