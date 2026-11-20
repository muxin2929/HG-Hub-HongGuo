import { useEffect, useReducer, useRef, useState } from 'react';
import type { Video } from '../data/types';
import { coverUrl, playErrorText } from '../data/api';
import { canPlayHevc, attachStream, findLiveFeedVideo, hasHevcStream, pauseFeedVideos, QUALITY_LABEL, availableQualities, resolvePlay, type AttachedPlayer, type QualityKey } from '../core/player';
import { NativeEl, engine, isNativeEl, nativeMode } from '../core/native';
import { FrameGrabber } from '../core/preview';
import { useLongPressBoost } from '../core/boost';
import { addHistory, getProgress, setProgress } from '../core/store';
import { auth, getToken } from '../core/auth';
import { isFav, isLiked, subscribeMarks, toggleFav, toggleLike } from '../core/marks';
import { fmtDuration, fmtNum } from '../lib/format';
import { useCommentCount } from '../core/useCommentCount';
import { Icon } from './Icons';
import { ScrubTip } from './ScrubTip';

const RANGE = 30;
const SPEEDS = [1, 1.25, 1.5, 2];

/**
 * 横屏全屏播放器（手机点「全屏观看」进入）。
 * 布局对齐参考图：左上返回+标题、右上分享/更多、左下亮度、右侧锁屏/音量、
 * 底部 进度条 + 点赞/评论/收藏 + 弹幕输入 + 倍速 + 清晰度 + 选集。
 */
export function LandscapePlayer({
  video,
  ep,
  onClose,
  startAt,
  host,
  onDetail,
  onComment,
  onShare,
  onToast,
}: {
  video: Video;
  ep: number;
  /** 退出时把当前播放位置交回去，下面的原生流直接从这儿接着播 */
  onClose: (at?: number, ep?: number) => void;
  startAt?: number;
  /** 竖屏播放页自己的 <video>：能接就接过来用（同一条流，不重载、不回第一集） */
  host?: HTMLVideoElement | null;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onToast: (t: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | any>(null);
  const nativeElRef = useRef<NativeEl | null>(null);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const lastGrab = useRef(0);
  const scrubAt = useRef(0);
  const scrubWasPlaying = useRef(false);
  const scrubOn = useRef(false);
  const [scrubX, setScrubX] = useState(0);
  const playerRef = useRef<AttachedPlayer | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const saveAt = useRef(0);
  // 全屏手势：长按 2 倍速 / 横滑调进度
  const [boostOn, setBoostOn] = useState(false);
  const [seekHint, setSeekHint] = useState<{ at: number; delta: number } | null>(null);
  const gest = useRef({ mode: 'idle' as 'idle' | 'seek' | 'vol', x: 0, y: 0, base: 0, w: 0, playing: false, vol0: 1, h: 0 });
  /** 这一次 pointer 手势是不是「从画面上起手」的：从进度条/控制条起的头绝不能交给 root 的横滑手势，
      否则两边各算一次进度，进度条会被 root 的旧起点拽回左边并且来回跳。 */
  const rootOwn = useRef(false);
  const seekTo = useRef(0);

  const total = video.episode_count || video.total_episodes || 1;
  const onFatal = () => {
    if (quality !== 'main') {
      setTip('本机解不了 1080P，已切回 720P');
      setQuality('main');
    } else {
      setTip('播放中断，正在重试…');
    }
  };
  const [cur, setCur] = useState(ep);
  const cmtN = useCommentCount(video);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  // 真正在缓冲/取流时为 true：中央显示转圈，而不是一个看起来「可播但没播」的三角
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [locked, setLocked] = useState(false);
  const [showEps, setShowEps] = useState(false);
  const [quality, setQuality] = useState<QualityKey>('main');
  const [effQuality, setEffQuality] = useState<QualityKey>('main');
  const [hasHevc, setHasHevc] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [range, setRange] = useState(Math.floor((ep - 1) / RANGE));
  /** 上下滑调音量时的提示（null = 不显示） */
  const [volHint, setVolHint] = useState<number | null>(null);
  const tapTimer = useRef(0);
  const tapAt = useRef(0);

  // 长按画面 = 临时 2 倍速；松手回到用户自己选的那一档
  const hold = useLongPressBoost({
    speed: () => speed,
    apply: (r) => {
      const el: any = videoRef.current;
      if (el) el.playbackRate = r;
    },
    onToggle: (on) => {
      setBoostOn(on);
      const el: any = videoRef.current;
      if (on && el?.paused) {
        try {
          void el.play();
        } catch {
          /* noop */
        }
      }
    },
  });
  // 收藏/点赞和首页/竖屏/我的页是同一份全局状态
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);
  const [tip, setTip] = useState('');
  const [uiVisible, setUiVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  /** 松手续播的观察期：这段时间不亮中央播放三角（拖动不是暂停） */
  const [scrubTail, setScrubTail] = useState(false);
  const scrubTailT = useRef(0);
  /** 拖动自己引起的 pause 不算用户暂停（不然中央会冒出播放三角） */
  const scrubPauseRef = useRef(false);
  /** 用户自己按的暂停才允许出现播放三角；拖动/缓冲/外部 pause 一律不认 */
  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);
  useEffect(() => {
    userPausedRef.current = userPaused;
  }, [userPaused]);
  const openAt = useRef(Date.now());
  const markPaused = () => {
    if (scrubPauseRef.current) return;
    setPaused(true);
  };
  const [frame, setFrame] = useState<{ url: string; time: number } | null>(null);

  // 换集 / 换清晰度 / 退出时把预览解码器收掉
  useEffect(() => {
    return () => {
      grabberRef.current?.dispose();
      grabberRef.current = null;
      lastGrab.current = 0;
    };
  }, [video.id, cur, quality]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const adoptedRef = useRef<{ el: HTMLVideoElement; parent: HTMLElement | null; style: string } | null>(null);

  /** 把接过来的画面原样还回它原来那一层（同一个元素、同一条流，不重载） */
  const giveBack = () => {
    const a = adoptedRef.current;
    if (!a) return;
    try {
      // 还回去的那条已经不是用户现在看的这一集：先停住，别在下面出声
      try {
        a.el.pause();
      } catch {
        /* noop */
      }
      a.el.setAttribute('style', a.style);
      a.el.classList.remove('hg-adopt');
      delete (a.el as any).dataset.hgAdopt;
      if (a.parent) a.parent.appendChild(a.el);
    } catch {
      /* noop */
    }
    adoptedRef.current = null;
    videoRef.current = null;
    setAdopted(false);
  };

  // 接管来的那一屏只服务它原来那一集：换了集就还回去，自己重新播这一集
  useEffect(() => {
    if (!adoptedRef.current) return;
    if (cur === ep) return;
    giveBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  useEffect(() => {
    if (!tip) return;
    const id = window.setTimeout(() => setTip(''), 1800);
    return () => window.clearTimeout(id);
  }, [tip]);

  useEffect(() => {
    if (nativeMode) return; // 原生模式：画面由下面的 ExoPlayer 直接接管，不需要搬 DOM
    const stage = hostRef.current;
    /**
     * 优先接管**竖屏播放页自己**的那个 <video>：同一个元素、同一条流，
     * 进全屏只是换个容器铺满屏幕，退回去再还给它 —— 不清流、不重载、不回第一集。
     */
    let candidate: HTMLVideoElement | null = null;
    const own = host as any as HTMLVideoElement | null;
    if (own && !isNativeEl(own) && own.isConnected) {
      candidate = own;
    }
    // 退一步：首页那一屏正在播的正是这一部这一集，也可以接管
    if (!candidate) {
      const f = findLiveFeedVideo();
      if (f && Number(f.dataset.hgVid) === video.id && Number(f.dataset.hgEp || 1) === ep) candidate = f;
    }
    const live = candidate;
    if (!live || !stage) {
      pauseFeedVideos();
      return;
    }
    const parent = live.parentElement;
    const style = live.getAttribute('style') || '';
    stage.appendChild(live);
    live.style.position = 'absolute';
    live.style.inset = '0';
    live.style.left = '0';
    live.style.top = '0';
    live.style.transform = 'none';
    live.style.width = '100%';
    live.style.height = '100%';
    live.style.objectFit = 'contain';
    videoRef.current = live;
    adoptedRef.current = { el: live, parent, style };
    // 用一个专用类把矩形/裁切强制拉正：首页那一屏的 video 自带 object-fit 等样式，
    // 只靠内联 style 在部分机型上会被压回去，表现就是「画面没铺满、还偏一边」
    live.classList.add('hg-adopt');
    setAdopted(true);
    // 接管进来的是另一条 <video>，自己那个空壳的 onXxx 收不到事件：
    // 进度/时长要在这里自己接一遍，否则底部永远是 0:00/0:00
    const onT = () => {
      if (scrubOn.current) return; // 正在拖：进度条由手指决定
      setTime(live.currentTime);
      setDur(live.duration || 0);
      if (live.readyState >= 3) setLoading(false);
    };
    const onPlay = () => setPaused(false);
    const onPause = () => markPaused();
    const onBusy = () => setLoading(true);
    const onReady = () => setLoading(false);
    live.addEventListener('timeupdate', onT);
    live.addEventListener('loadedmetadata', onT);
    live.addEventListener('play', onPlay);
    live.addEventListener('pause', onPause);
    live.addEventListener('waiting', onBusy);
    live.addEventListener('playing', onReady);
    live.addEventListener('canplay', onReady);
    onT();
    live.play().catch(() => undefined);
    return () => {
      live.removeEventListener('timeupdate', onT);
      live.removeEventListener('loadedmetadata', onT);
      live.removeEventListener('play', onPlay);
      live.removeEventListener('pause', onPause);
      live.removeEventListener('waiting', onBusy);
      live.removeEventListener('playing', onReady);
      live.removeEventListener('canplay', onReady);
      live.classList.remove('hg-adopt');
      setAdopted(false);
      const a = adoptedRef.current;
      if (!a) return;
      if (a.parent) {
        a.el.setAttribute('style', a.style);
        a.parent.appendChild(a.el);
      }
      adoptedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [rotated, setRotated] = useState(false);
  // App 里靠真转屏，Web 的整屏兜底旋转只在浏览器里用
  const rot = !nativeMode && rotated;
  // 接管了首页那条视频之后，自己这个空壳要藏起来，不然海报会盖住正在播的画面
  const [adopted, setAdopted] = useState(false);
  const hideTimer = useRef(0);

  // 进入时尽量进全屏 + 锁横屏（支持就锁，不支持也不影响）
  useEffect(() => {
    if (nativeMode) {
      // App 内：原生画面没法跟着 CSS 旋转走，直接让壳层真转屏；
      // Activity 声明了 configChanges，转屏不会重建 WebView
      engine.orient(1);
      const onResize = () => engine.syncRect();
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        engine.orient(2);
      };
    }
    const el = document.documentElement;
    el.requestFullscreen?.().catch(() => undefined);
    const so: any = (screen as any).orientation;
    try {
      so?.lock?.('landscape')?.catch?.(() => undefined);
    } catch {
      /* 不支持锁屏就靠下面的兜底旋转 */
    }
    // 只有「真的还是竖屏」才整屏旋转 90°兜底。转屏成功后必须自动摘掉，
    // 否则画面会被转两次，整块跑到屏幕外 → 看着就是黑的
    const check = () => setRotated(window.innerHeight > window.innerWidth + 40);
    const t1 = window.setTimeout(check, 420);
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.clearTimeout(t1);
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
      try {
        so?.unlock?.();
      } catch {
        /* noop */
      }
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);

  // 原生模式：直接用**同一个**原生播放器，只把画面矩形挪到这个全屏页上。
  // 同一条流不重新取、不传进度——这才是真的「不断」。
  useEffect(() => {
    if (!nativeMode) return;
    const el = nativeElRef.current;
    if (!el) return;
    let alive = true;
    const offs: Array<() => void> = [];
    setLoading(true);
    (async () => {
      try {
        const bundle = await resolvePlay(video.id, cur);
        const hevcOk = canPlayHevc() && hasHevcStream(bundle.manifest);
        setHasHevc(hevcOk);
        const actual: QualityKey = quality === 'hevc' && hevcOk ? 'hevc' : 'main';
        setEffQuality(actual);
        playerRef.current = await attachStream(el, video.id, cur, onFatal, actual);
        if (!alive) return;
        el.muted = muted;
        el.playbackRate = speed;
        offs.push(
          el.on('timeupdate', () => {
            if (scrubOn.current) return; // 正在拖：进度条由手指决定
            setTime(el.currentTime);
            setDur(el.duration || 0);
            if (el.currentTime > 0) setLoading(false);
            const now = Date.now();
            if (now - saveAt.current > 5000 && el.duration) {
              saveAt.current = now;
              setProgress(video.id, cur, el.currentTime, el.duration);
              addHistory(video, cur);
            }
          }),
          el.on('loadedmetadata', () => setDur(el.duration || 0)),
          el.on('play', () => setPaused(false)),
          el.on('pause', () => markPaused()),
          el.on('ended', () => setCur((n) => Math.min(total, n + 1))),
          el.on('frame', () => setFrame({ url: el.frameUrl, time: el.frameTime })),
          el.on('error', () => onFatal()),
        );
        setDur(el.duration || 0);
        if (cur === ep && startAt && startAt > 1) {
          try {
            el.currentTime = startAt;
          } catch {
            /* noop */
          }
        }
        await el.play().catch(() => undefined);
      } catch (e: any) {
        if (alive) setTip(playErrorText(e?.message));
      }
    })();
    return () => {
      alive = false;
      offs.forEach((off) => off());
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, cur, quality]);

  /** 原生平台的占位块：只量尺寸，画面从原生层透上来 */
  const bindNative = (node: HTMLDivElement | null) => {
    if (!nativeElRef.current) nativeElRef.current = new NativeEl('landscape', 'contain');
    const ne = nativeElRef.current;
    if (node) {
      ne.host = node;
      ne.fit = 'contain';
      videoRef.current = ne;
    } else {
      ne.host = null;
    }
  };

  // 网页（非 App）模式：自己建 hls 播
  useEffect(() => {
    if (nativeMode) return;
    // 画面是从别的层接过来的：它带着自己的流，这里绝不能重新取流（否则就变成「重播第一集」）
    if (adoptedRef.current) return;
    const el = videoRef.current;
    if (!el) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        playerRef.current?.destroy();
        const bundle = await resolvePlay(video.id, cur);
        const hevcOk = canPlayHevc() && hasHevcStream(bundle.manifest);
        setHasHevc(hevcOk);
        const actual: QualityKey = quality === 'hevc' && hevcOk ? 'hevc' : 'main';
        setEffQuality(actual);
        playerRef.current = await attachStream(el, video.id, cur, onFatal, actual);
        if (!alive) return;
        el.playbackRate = speed;
        await el.play().catch(() => undefined);
        if (cur === ep) {
          const p = getProgress(video.id);
          const want0 =
            startAt && startAt > 1
              ? startAt
              : p && p.ep === cur && p.t > 10 && p.dur && p.t < p.dur - 10
                ? p.t
                : 0;
          if (want0 > 1) {
            const seek = () => {
              try {
                el.currentTime = want0;
              } catch {
                /* noop */
              }
            };
            el.addEventListener('loadedmetadata', seek, { once: true });
            window.setTimeout(seek, 800);
          }
        }
      } catch (e: any) {
        if (alive) setTip(playErrorText(e?.message));
      }
    })();
    return () => {
      alive = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, cur, quality, adopted]);

  const togglePlay = () => {
    if (Date.now() - openAt.current < 520) return; // 吃掉「点进全屏」那一下漏进来的点击
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      setUserPaused(false);
      setLoading(true);
      el.play().catch(() => undefined);
    } else {
      if (loading || el.seeking) return;
      setUserPaused(true);
      el.pause();
    }
  };

  /** 点画面中心 = 暂停/继续（抬手才判定）；其它地方 = 唤出 UI
   *  另外两条手势：长按 = 临时 2 倍速，横向划动 = 调进度 */
  const onRootDown = (e: React.PointerEvent) => {
    // 默认这一下不归 root 管；只有真的落在画面上，才在下面把 rootOwn 置真
    rootOwn.current = false;
    if (scrubOn.current) return; // 拖进度条期间不响应画面手势
    const root = e.currentTarget as HTMLElement;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 控件/弹层上的操作交给它们自己，这里只负责「唤出 UI」
    if ((e.target as HTMLElement).closest('.lhead,.lbar,.lright,.lbigplay,.epsheet,.speedsheet,.sheet-mask,.lunlock,.lprog')) {
      bumpUi();
      return;
    }
    const el: any = videoRef.current;
    rootOwn.current = true;
    gest.current = {
      mode: 'idle',
      x: e.clientX,
      y: e.clientY,
      base: Number(el?.currentTime || 0),
      w: r.width,
      h: r.height,
      playing: !!el && !el.paused,
      vol0: typeof el?.volume === 'number' ? el.volume : 1,
    };
    hold.down();
    bumpUi();
  };

  const onRootMove = (e: React.PointerEvent) => {
    // 手势不是从画面起的（比如在进度条上拖）：这里一律不碰，进度只由进度条自己说了算
    if (!rootOwn.current) return;
    const g = gest.current;
    if (g.mode === 'idle') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      hold.move(dx, dy);
      // 上下滑 = 调音量（右侧上下划的常见做法）；左右滑 = 调进度
      if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx) * 1.25) {
        g.mode = 'vol';
        setVolHint(g.vol0);
        hold.cancel();
      } else if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        // 横向划动接管：画面先定住，进度只做预览
        g.mode = 'seek';
        scrubOn.current = true;
        setFrame(null); // 别拿上一次的旧帧冒充这一次的预览
        seekTo.current = g.base;
        const el: any = videoRef.current;
        try {
          el?.pause?.();
        } catch {
          /* noop */
        }
      }
    }
    if (g.mode === 'vol') {
      const el: any = videoRef.current;
      if (!el) return;
      const dy = e.clientY - g.y;
      const next = Math.max(0, Math.min(1, g.vol0 - dy / Math.max(120, g.h * 0.55)));
      try {
        el.volume = next;
        if (next > 0 && el.muted) el.muted = false;
      } catch {
        /* noop */
      }
      setVolHint(next);
      return;
    }
    if (g.mode !== 'seek') return;
    const total = dur || Number((videoRef.current as any)?.duration || 0);
    if (!total) return;
    const dx = e.clientX - g.x;
    // 一屏宽 ≈ 这一段：幅度小一点，别一滑就跳到片尾
    const span = Math.min(60, Math.max(10, total / 6));
    const next = Math.max(0, Math.min(total, g.base + (dx / g.w) * span));
    seekTo.current = next;
    setTime(next);
    setSeekHint({ at: next, delta: next - g.base });
  };

  const onRootUp = (e: React.PointerEvent) => {
    if (!rootOwn.current) return; // 进度条/控件起的头：抬手也不归 root 处理，免得把进度拽回去
    rootOwn.current = false;
    const wasBoost = hold.up();
    const g = gest.current;
    if (wasBoost) {
      // 长按快放结束：抬手这一下不当作点击
      g.mode = 'idle';
      return;
    }
    if (g.mode === 'seek') {
      const el: any = videoRef.current;
      const at = seekTo.current;
      setVolHint(null);
      try {
        if (el) el.currentTime = at;
      } catch {
        /* noop */
      }
      setTime(at);
      scrubOn.current = false; // 放开之后让播放器自己报进度
      setSeekHint(null);
      g.mode = 'idle';
      if (g.playing) {
        try {
          void el?.play();
        } catch {
          /* noop */
        }
      }
      return;
    }
    g.mode = 'idle';
    if (locked) return;
    const root = e.currentTarget as HTMLElement;
    const r = root.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    const half = 44;
    const center = Math.abs(cx) < half && Math.abs(cy) < half;
    // 单击/双击仲裁：等一小会儿看会不会来第二下，双击就暂停，单击才唤出/收起 UI
    const now = Date.now();
    if (now - tapAt.current < 280) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      tapAt.current = 0;
      togglePlay();
      return;
    }
    tapAt.current = now;
    const wasVisible = uiVisible;
    window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      tapAt.current = 0;
      if (center) {
        togglePlay();
        return;
      }
      // 点画面：唤出；再点一下：收起（按「按下之前」的状态判断，避免被唤出后的重渲染带偏）
      if (wasVisible) {
        window.clearTimeout(hideTimer.current);
        setUiVisible(false);
      } else {
        bumpUi();
      }
    }, 280);
  };

  const onRootCancel = () => {
    if (!rootOwn.current) return;
    rootOwn.current = false;
    hold.cancel();
    const g = gest.current;
    if (g.mode === 'seek') {
      scrubOn.current = false;
      setSeekHint(null);
    }
    if (g.mode === 'vol') setVolHint(null);
    g.mode = 'idle';
  };

  const seekAt = (track: HTMLElement, clientX: number, clientY: number, final = false) => {
    const el = videoRef.current;
    const r = track.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 整屏兜底旋转 90° 时，轨道在屏幕上变成竖的：这时候必须按 Y 算，
    // 否则会出现「不跟手、还反着来」
    const ratio = rot
      ? Math.min(1, Math.max(0, (clientY - r.top) / r.height))
      : Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const total = el?.duration || dur;
    if (!total) return;
    const at = ratio * total;
    scrubAt.current = at;
    // 进度条立刻跟手，不等解码也不等 seek
    setTime(at);
    setScrubX(ratio);
    grabPreview(at, final);
    // 真正跳转放在松手那一下，拖动过程中主画面不动
    if (final && el) {
      try {
        el.currentTime = at;
      } catch {
        /* noop */
      }
      setTime(at);
    }
  };

  /** 目标时间那一帧的真图：原生走原生抓位图，网页走独立解码实例 */
  const grabPreview = (at: number, final: boolean) => {
    const el = videoRef.current;
    if (!el) return;
    if (isNativeEl(el)) {
      const now = performance.now();
      if (!final && now - lastGrab.current < 160) return;
      lastGrab.current = now;
      el.capture(at);
      return;
    }
    if (!grabberRef.current) grabberRef.current = new FrameGrabber(video.id, cur, quality);
    const g = grabberRef.current;
    if (final) g.flush(at, (url, t) => setFrame({ url, time: t }));
    else g.push(at, (url, t) => setFrame({ url, time: t }));
  };

  const ranges: Array<[number, number]> = [];
  for (let s = 1; s <= total; s += RANGE) ranges.push([s, Math.min(total, s + RANGE - 1)]);
  const curRange = ranges[range] || [1, total];
  const eps: number[] = [];
  for (let n = curRange[0]; n <= curRange[1]; n++) eps.push(n);
  /**
   * 时长优先信元素自己的：有些机器上 loadedmetadata 没进 React 回调，
   * state 里的 dur 还是 0，进度条就会永远贴在最左边 —— 看着像「拖了也不跟手」。
   */
  const durNow = dur || Number((videoRef.current as any)?.duration || 0) || 0;
  const pct = durNow ? Math.min(100, (time / durNow) * 100) : 0;

  // 8 秒不动就隐藏所有 UI，触摸再显示（太短会让人刚唤出就没了）
  const bumpUi = () => {
    setUiVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setUiVisible(false), 8000);
  };

  useEffect(() => {
    bumpUi();
    // 兜底：不管手势落在哪一层（接管的 <video>、遮罩、旋转后的空白区），
    // 都要能把 UI 唤回来。只监听 window 捕获阶段，不参与业务判断。
    const wake = () => bumpUi();
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('touchstart', wake, true as any);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('touchstart', wake, true as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`lplayer${locked ? ' locked' : ''}${rot ? ' rot' : ''}${uiVisible ? '' : ' hideui'}${
        scrubbing ? ' scrubbing' : ''
      }`}
      onPointerDown={onRootDown}
      onPointerMove={onRootMove}
      onPointerUp={onRootUp}
      onPointerCancel={onRootCancel}
    >
      {nativeMode ? (
        // 原生层就在这一层下面：这层只量矩形，画面由下面的 ExoPlayer 透上来
        <div className="lhost nstage-l" ref={bindNative} />
      ) : (
        <>
          <div className="lhost" ref={hostRef} />
          <video
            ref={videoRef}
            className="lvideo"
            style={adopted ? { display: 'none' } : undefined}
            playsInline
            preload="auto"
            poster={coverUrl(video.cover)}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              if (scrubOn.current) return; // 正在拖：进度条由手指决定
              setTime(el.currentTime);
              setDur(el.duration || 0);
              if (el.currentTime > 0) setLoading(false);
              const now = Date.now();
              if (now - saveAt.current > 5000 && el.duration) {
                saveAt.current = now;
                setProgress(video.id, cur, el.currentTime, el.duration);
                addHistory(video, cur);
              }
            }}
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
            onPlay={() => {
              setPaused(false);
              setUserPaused(false);
              setLoading(false);
            }}
            onPause={() => markPaused()}
            onWaiting={() => setLoading(true)}
            onPlaying={() => {
              setUserPaused(false);
              setLoading(false);
            }}
            onCanPlay={(e) => {
              if (e.currentTarget.paused) return;
              setLoading(false);
            }}
            onEnded={() => {
              setUserPaused(true);
              setCur((n) => Math.min(total, n + 1));
            }}
          />
        </>
      )}

      {!locked && (userPaused || loading || paused) && (
        <button
          type="button"
          className="lbigplay"
          onClick={togglePlay}
          aria-label={userPaused ? '继续播放' : '加载中'}
        >
          {userPaused ? <Icon name="play" size={40} strokeWidth={2} /> : <span className="hg-spin big" />}
        </button>
      )}
      {tip && <div className="ltip">{tip}</div>}
      {volHint !== null && <div className="ltip">音量 {Math.round(volHint * 100)}%</div>}
      {boostOn && <div className="lboost">2 倍速播放中</div>}
      {seekHint && (
        <div className="lseekhint">
          <b>
            {seekHint.delta >= 0 ? '+' : '-'}
            {fmtDuration(Math.abs(seekHint.delta))}
          </b>
          <span>
            {fmtDuration(seekHint.at)} / {fmtDuration(dur)}
          </span>
        </div>
      )}

      {!locked && (
        <>
          <header className="lhead" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="licon"
              onClick={() => onClose(videoRef.current?.currentTime || 0, cur)}
              aria-label="返回"
            >
              <Icon name="back" size={24} strokeWidth={2.2} />
            </button>
            <button type="button" className="ltitle" onClick={() => onDetail(video.id)}>
              {video.title} <em>第{cur}集</em>
            </button>
            <span className="lsp" />
            <button type="button" className="licon" onClick={() => onShare(video, cur)} aria-label="分享">
              <Icon name="share" size={20} strokeWidth={1.9} />
            </button>
          </header>

          

          <div className="lright" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="licon" onClick={() => setLocked(true)} aria-label="锁定">
              <Icon name="lock" size={20} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              className="licon"
              onClick={() => {
                setMuted((m) => !m);
                const el = videoRef.current;
                if (el) el.muted = !muted;
              }}
              aria-label="声音"
            >
              <Icon name={muted ? 'mute' : 'vol'} size={20} strokeWidth={1.9} />
            </button>
          </div>

          <div className="lbar" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <div
              className={`lprog${scrubbing ? ' on' : ''}`}
              ref={trackRef}
              onPointerDown={(e) => {
                e.stopPropagation();
                rootOwn.current = false; // 这一笔从进度条起头，横滑手势不许掺和
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                dragRef.current = true;
                scrubOn.current = true;
                setScrubbing(true);
                setFrame(null);
                // 拖的时候把画面定住，才看得清划到的那一帧
                const el: any = videoRef.current;
                scrubWasPlaying.current = !!el && !el.paused;
                try {
                  el?.pause?.();
                } catch {
                  /* noop */
                }
                // 拖动造成的 pause 不该显示暂停三角，也不该触发 pause 事件
                if (scrubWasPlaying.current) {
                  scrubPauseRef.current = true;
                  setPaused(false);
                }
                seekAt(e.currentTarget, e.clientX, e.clientY);
              }}
              onPointerMove={(e) => dragRef.current && seekAt(e.currentTarget, e.clientX, e.clientY)}
              onPointerUp={(e) => {
                dragRef.current = false;
                scrubOn.current = false;
                const at = scrubAt.current;
                const el: any = videoRef.current;
                try {
                  if (el && at > 0) el.currentTime = at;
                } catch {
                  /* noop */
                }
                grabPreview(at, true);
                setScrubbing(false);
                if (scrubWasPlaying.current) {
                  setLoading(true);
                  setPaused(false);
                  setScrubTail(true);
                  window.clearTimeout(scrubTailT.current);
                  scrubTailT.current = window.setTimeout(() => {
                    setScrubTail(false);
                    scrubPauseRef.current = false;
                  }, 700);
                  try {
                    el?.play?.()?.catch?.(() => undefined);
                  } catch {
                    /* noop */
                  }
                }
              }}
              onPointerCancel={() => {
                dragRef.current = false;
                scrubOn.current = false;
                setScrubbing(false);
              }}
            >
              {scrubbing && durNow > 0 && (
                <ScrubTip className="lprev" url={frame?.url} time={time} dur={durNow} x={scrubX} />
              )}
              <i style={{ width: `${pct}%` }} />
            </div>

            <div className="lrow">
              <button type="button" className="lact" onClick={togglePlay}>
                <Icon name={paused ? 'play' : 'pause'} size={20} strokeWidth={2} />
              </button>
              <span className="ltime">
                {fmtDuration(time)}/{fmtDuration(dur)}
              </span>

              <button
                type="button"
                className={`lact${isLiked(video.id) ? ' on' : ''}`}
                onClick={() => {
                  void toggleLike(video).then(() => bumpMarks());
                }}
              >
                <Icon name={isLiked(video.id) ? 'heartFill' : 'heart'} size={20} strokeWidth={1.9} />
                {fmtNum((video.like_count || 0))}
              </button>
              <button type="button" className="lact" onClick={() => onComment(video)}>
                <Icon name="chat" size={20} strokeWidth={1.9} />
                {fmtNum(cmtN)}
              </button>
              <button
                type="button"
                className={`lact${isFav(video.id) ? ' on' : ''}`}
                onClick={() => {
                  void toggleFav(video).then(() => bumpMarks());
                }}
              >
                <Icon name={isFav(video.id) ? 'starFill' : 'star'} size={20} strokeWidth={1.7} />
                {fmtNum((video.collect_count || 0) + (isFav(video.id) ? 1 : 0))}
              </button>

              <span className="dctl-sp" />
              {/* 选集 / 清晰度 / 倍速：固定贴在右下角，和左边的点赞评论分开 */}
              <span className="lfunc">
                <button
                  type="button"
                  className="lact"
                  onClick={() => {
                    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                    setSpeed(next);
                    const el = videoRef.current;
                    if (el) el.playbackRate = next;
                  }}
                >
                  {speed.toFixed(1)}x
                </button>
                <button type="button" className="lact" onClick={() => setShowQuality(true)}>
                  {QUALITY_LABEL[effQuality].split(' ')[1] || '720P'}
                </button>
                <button type="button" className="lact" onClick={() => setShowEps(true)}>
                  选集
                </button>
              </span>
            </div>
          </div>
        </>
      )}

      {locked && (
        <button type="button" className="lunlock" onClick={() => setLocked(false)}>
          <Icon name="lock" size={16} strokeWidth={1.9} />
          点击解锁
        </button>
      )}

      {showQuality && (
        <>
          <div className="sheet-mask" onClick={() => setShowQuality(false)} />
          <div className="speedsheet">
            <div className="eps-head">
              <span>清晰度</span>
              <span className="eps-sub">{hasHevc ? '720P / 1080P' : '本集无 1080P 流'}</span>
            </div>
            <div className="speed-list">
              {availableQualities()
                .filter((q) => q === 'main' || hasHevc)
                .map((q) => (
                <button
                  key={q}
                  type="button"
                  className={q === effQuality ? 'on' : ''}
                  onClick={() => {
                    if (q === effQuality) {
                      setShowQuality(false);
                      return;
                    }
                    setQuality(q);
                    setShowQuality(false);
                    // 换清晰度必须给反馈：否则不知道是真换了还是 UI 敷衍了一下
                    setTip(`已切换到 ${QUALITY_LABEL[q]}`);
                    setLoading(true);
                  }}
                >
                  {QUALITY_LABEL[q]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {showEps && (
        <>
          <div className="sheet-mask" onClick={() => setShowEps(false)} />
          <div className="epsheet">
            <div className="eps-head">
              <span>选集</span>
              <span className="eps-sub">
                {video.is_finished ? '已完结' : '连载中'} · 全{total}集
              </span>
            </div>
            {ranges.length > 1 && (
              <div className="eps-ranges">
                {ranges.map(([a, b], i) => (
                  <button key={a} type="button" className={i === range ? 'on' : ''} onClick={() => setRange(i)}>
                    {a}-{b}
                  </button>
                ))}
              </div>
            )}
            <div className="eps-grid">
              {eps.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={n === cur ? 'on' : ''}
                  onClick={() => {
                    setCur(n);
                    setShowEps(false);
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
