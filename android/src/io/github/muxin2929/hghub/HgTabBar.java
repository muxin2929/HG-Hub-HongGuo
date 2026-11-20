package io.github.muxin2929.hghub;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 原生底部导航（首页 / 剧场 / 榜单 / 我的）。
 *
 * 尺寸与网页里的 .tabbar 完全对齐：高 54dp、图标 23dp、文字 11sp、图标与文字间距 2dp，
 * 这样换成本地控件后页面底部留白不会错位（styles.css 的 --tab-h 就是 54px）。
 *
 * 图标用 Path 现画（工程里没有 R 类，不走资源）。几何形状照抄网页 icons 的 svg path，
 * 24×24 坐标系、1.75 描边，缩放到 23dp —— 与网页端看着是同一套图标。
 *
 * 点击不直接改页面，而是回调给 JS（window.__hgTab），复用网页里已有的切 tab 逻辑
 * （含"再点一次首页重新推荐"）。
 */
public class HgTabBar extends LinearLayout {

    public interface OnTabClick {
        void onTab(String key);
    }

    private static final int BAR_H = 54;      // dp
    private static final int ICON = 23;       // dp
    private static final float LABEL_SP = 11f;

    private static final String[] KEYS = {"home", "theater", "rank", "mine"};
    private static final String[] LABELS = {"首页", "剧场", "榜单", "我的"};

    private final ImageView[] icons = new ImageView[KEYS.length];
    private final TextView[] labels = new TextView[KEYS.length];
    private final Drawable[] iconDrawables = new Drawable[KEYS.length];
    private final OnTabClick click;

    private String active = "home";
    private boolean darkMode = true;
    private final int barHeightPx;

    public HgTabBar(Context ctx, OnTabClick click) {
        super(ctx);
        this.click = click;
        barHeightPx = dp(BAR_H);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER_VERTICAL);
        setClickable(true);
        for (int i = 0; i < KEYS.length; i++) {
            addItem(i);
        }
        applySkin();
        paintItems();
    }

    private void addItem(int i) {
        FrameLayout box = new FrameLayout(getContext());
        box.setLayoutParams(new LayoutParams(0, barHeightPx, 1f));
        box.setClickable(true);

        LinearLayout inner = new LinearLayout(getContext());
        inner.setOrientation(VERTICAL);
        inner.setGravity(Gravity.CENTER_HORIZONTAL);
        inner.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));

        ImageView ic = new ImageView(getContext());
        ic.setLayoutParams(new LinearLayout.LayoutParams(dp(ICON), dp(ICON)));
        Drawable d = iconFor(i);
        iconDrawables[i] = d;
        ic.setImageDrawable(d);

        TextView tv = new TextView(getContext());
        LinearLayout.LayoutParams tvlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tvlp.topMargin = dp(2);
        tv.setLayoutParams(tvlp);
        tv.setText(LABELS[i]);
        tv.setTextSize(LABEL_SP);
        tv.setIncludeFontPadding(false);

        inner.addView(ic);
        inner.addView(tv);
        box.addView(inner);

        final String key = KEYS[i];
        box.setOnClickListener(v -> {
            // 按压回缩一下再弹回，和网页端 tab 的点击手感一致
            v.animate().scaleX(0.94f).scaleY(0.94f).setDuration(90).withEndAction(() ->
                    v.animate().scaleX(1f).scaleY(1f).setDuration(150).start()).start();
            if (click != null) click.onTab(key);
        });

        addView(box);
        icons[i] = ic;
        labels[i] = tv;
    }

    /** 当前选中项（由网页上报，保证和页面里的状态一致） */
    public void setActive(String key) {
        if (key == null || key.isEmpty()) return;
        active = key;
        paintItems();
    }

    /** 首页 feed 是黑底，tabbar 跟着变深色；其余页面白底 */
    public void setDarkMode(boolean dark) {
        if (darkMode == dark) return;
        darkMode = dark;
        applySkin();
        paintItems();
    }

    /** 详情页 / 播放页 / 全屏时不显示 */
    public void setBarVisible(boolean visible) {
        setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    public int barHeight() {
        return barHeightPx;
    }

    private void applySkin() {
        if (darkMode) {
            setBackground(new GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    new int[]{0xB3000000, 0xEB000000}));
        } else {
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.WHITE);
            bg.setStroke(dp(1), 0xFFEEEEEE);
            setBackground(bg);
        }
    }

    private void paintItems() {
        for (int i = 0; i < KEYS.length; i++) {
            boolean on = KEYS[i].equals(active);
            int color;
            if (darkMode) {
                color = on ? 0xFFFFFFFF : 0xFF9B9FA3;
            } else {
                color = on ? 0xFF111111 : 0xFF999999;
            }
            if (iconDrawables[i] instanceof LineIcon) {
                LineIcon li = (LineIcon) iconDrawables[i];
                li.tint(color);
                // 选中加粗：网页端选中态 strokeWidth 2.1、未选中 1.75
                li.stroke(on ? 2.1f : 1.75f);
                li.invalidateSelf();
            }
            labels[i].setTextColor(color);
            labels[i].getPaint().setFakeBoldText(on);
            labels[i].requestLayout();
        }
    }

    // ---------------------------------------------------------------- 图标
    // 全部手工构造（Path.parse 是 API 26 才有的，minSdk 24 不能用）。
    private static Drawable iconFor(int i) {
        switch (i) {
            case 0: {
                Path roof = new Path();
                roof.moveTo(3.2f, 10.2f);
                roof.lineTo(12f, 3.3f);
                roof.lineTo(20.8f, 10.2f);
                Path body = new Path();
                body.moveTo(5.6f, 9.4f);
                body.lineTo(5.6f, 20.8f);
                body.lineTo(18.4f, 20.8f);
                body.lineTo(18.4f, 9.4f);
                return new LineIcon(new Path[]{roof, body}, 24f);
            }
            case 1: {
                Path box = new Path();
                box.addRoundRect(new RectF(3, 4.5f, 21, 19.5f), 2.4f, 2.4f, Path.Direction.CW);
                Path tri = new Path();
                tri.moveTo(10.2f, 9.2f);
                tri.lineTo(15f, 12f);
                tri.lineTo(10.2f, 14.8f);
                tri.close();
                return new LineIcon(new Path[]{box, tri}, 24f);
            }
            case 2: {
                Path cup = new Path();
                cup.moveTo(7f, 4f);
                cup.lineTo(17f, 4f);
                cup.lineTo(17f, 9.5f);
                cup.cubicTo(17f, 12.26f, 14.76f, 14.5f, 12f, 14.5f);
                cup.cubicTo(9.24f, 14.5f, 7f, 12.26f, 7f, 9.5f);
                cup.lineTo(7f, 4f);
                Path hL = new Path();
                hL.moveTo(7f, 5.5f);
                hL.lineTo(4.3f, 5.5f);
                hL.cubicTo(4.3f, 8.2f, 5.6f, 9.6f, 7.2f, 10.4f);
                Path hR = new Path();
                hR.moveTo(17f, 5.5f);
                hR.lineTo(19.7f, 5.5f);
                hR.cubicTo(19.7f, 8.2f, 18.4f, 9.6f, 16.8f, 10.4f);
                Path stem = new Path();
                stem.moveTo(12f, 14.5f);
                stem.lineTo(12f, 18f);
                Path base = new Path();
                base.moveTo(8f, 20.5f);
                base.lineTo(16f, 20.5f);
                return new LineIcon(new Path[]{cup, hL, hR, stem, base}, 24f);
            }
            default: {
                Path head = new Path();
                head.addCircle(12f, 8f, 3.7f, Path.Direction.CW);
                Path body = new Path();
                body.addArc(new RectF(4.6f, 13f, 19.4f, 27.8f), 180f, 180f);
                return new LineIcon(new Path[]{head, body}, 24f);
            }
        }
    }

    /** 24×24 坐标里的 1.75 描边图标，可整体换色 */
    private static class LineIcon extends Drawable {
        private final Path[] paths;
        private final float view;
        private int tint = Color.WHITE;
        private float stroke = 1.75f;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        LineIcon(Path[] paths, float view) {
            this.paths = paths;
            this.view = view;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        void tint(int c) {
            tint = c;
        }

        void stroke(float w) {
            stroke = w;
        }

        @Override
        public void draw(Canvas canvas) {
            Rect b = getBounds();
            if (b.width() <= 0 || b.height() <= 0) return;
            float s = Math.min(b.width(), b.height()) / view;
            paint.setColor(tint);
            paint.setStrokeWidth(stroke);
            canvas.save();
            canvas.translate(b.left + (b.width() - view * s) / 2f,
                    b.top + (b.height() - view * s) / 2f);
            canvas.scale(s, s);
            for (Path p : paths) canvas.drawPath(p, paint);
            canvas.restore();
        }

        @Override
        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
        }

        @Override
        public void setColorFilter(ColorFilter cf) {
            paint.setColorFilter(cf);
        }

        @Override
        public int getOpacity() {
            return android.graphics.PixelFormat.TRANSLUCENT;
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
