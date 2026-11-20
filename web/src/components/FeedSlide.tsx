import { useCallback, useEffect, useRef, useState } from 'react';
import type { Video } from '../data/types';
import { coverUrl } from '../data/api';
import { attachStream, availableQualities, canPlayHevc, defaultQuality, hasHevcStream, QUALITY_LABEL, preloadPlay, resolvePlay, type AttachedPlayer, type QualityKey } from '../core/player';
import { NativeEl, isNativeEl, livePlayback, nativeMode } from '../core/native';
import { FrameGrabber } from '../core/preview';
import { addHistory, getProgress, setProgress as saveProgress } from '../core/store';
import { auth, getToken } from '../core/auth';
import { fmtDuration, fmtHeat, fmtNum } from '../lib/format';
import { Icon } from './Icons';
import { useCommentCount } from '../core/useCommentCount';
import { Danmaku } from './Danmaku';

/**
 * 单卡播放器（手机 + PC 共用）。
 *  - 进度条：可拖动（pointer 捕获），松手提交；PC 悬停实时预览该帧画面
 *  - 全屏：浏览器 Fullscreen API（作用在整张卡上，浮层不丢）
 *  - 手机长按：2 倍速；按住上滑锁定，再点一下解锁
 */
export function FeedSlide({
  v,
  index,
  active,
  muted,
  danmaku,
  onToggleMute,
  onOpen,
  desktop,
  onDetail,
  onComment,
  onShare,
  onLandscape,
  onToast,
  onAdvance,
  onLike,
  liked,
  faved,
  onFav,
  ep = 1,
  quality = defaultQuality(),
  onPickEpisode,
  onPickQuality,
  suspend = false,
  idxStyle,
}: {
  v: Video;
  index: number;
  active: boolean;
  muted: boolean;
  ep?: number;
  quality?: QualityKey;
  onPickEpisode?: (v: Video) => void;
  onPickQuality?: (q: QualityKey) => void;
  danmaku: string[];
  onToggleMute: () => void;
  desktop?: boolean;
  onOpen: (v: Video, ep: number, at?: number) => void;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onLandscape: (v: Video, ep: number, at?: number) => void;
  onToast: (t: string) => void;
  onAdvance: () => void;
  onLike: () => void;
  liked: boolean;
  faved: boolean;
  onFav: () => void;
  /** 播放页盖在首页时暂停首页的自动续播/交互 */
  suspend?: boolean;
  /** 分页轨道里的第几屏（--i），由 ChannelFeed 的翻页器定位 */
  idxStyle?: React.CSSProperties;
}) {
  const slideRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<any>(null);
  const nativeElRef = useRef<NativeEl | null>(null);
  const playerRef = useRef<AttachedPlayer | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastTap = useRef(0);
  const dragRef = useRef(false);
  const hoverFrom = useRef<number | null>(null);
  const lastPreview = useRef(0);
  const pressTimer = useRef<number | null>(null);
  const pressActive = useRef(false);
  const speedLocked = useRef(false);
  const suppressClick = useRef(false);
  const saveAt = useRef(0);

  const [ready, setReady] = useState(false);
  /** 首帧真的画出来了吗？（loadeddata 之后才有画面，之前 video 是一整块黑） */
  const [painted, setPainted] = useState(false);
  /** 真正在缓冲（waiting）：中央给转圈，别让人对着静止画面猜 */
  const [buffering, setBuffering] = useState(false);
  const bufRef = useRef(false);
  const lastAdvance = useRef(0);
  const setBuf = (on: boolean) => {
    if (bufRef.current === on) return;
    bufRef.current = on;
    setBuffering(on);
  };
  /** 上次挂的是哪一部哪一集：只有真的换了才重置「已出画面」，同一集回来不闪封面 */
  const lastKeyRef = useRef('');
  /** 上一次挂的是哪部哪集（不含清晰度）：仅换清晰度时要保住当前播放时间 */
  const lastShowRef = useRef('');
  const [paused, setPaused] = useState(true);
  /** 实际挂上的流（这一集没 hevc 时，选了 1080 也仍然是 main） */
  const [effQuality, setEffQuality] = useState<QualityKey>(quality);
  const [hasHevc, setHasHevc] = useState(false);
  const [progress, setProgress] = useState(0);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [flash, setFlash] = useState('');
  const [heart, setHeart] = useState(false);
  const [failed, setFailed] = useState(false);
  // 全屏观看按钮：贴着视频画面下沿固定距离，避免压住画面
  // 原生的 <video> 并不存在，尺寸要从原生层回报的 videoWidth/Height 来算，所以拆出 applyFit
  const applyFit = (vw: number, vh: number) => {
    const stage = stageRef.current;
    if (!stage || !vw || !vh) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (!cw || !ch) return;
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    setFit({ w: Math.round(dw), h: Math.round(dh) });
    setBtnTop(Math.round((ch + dh) / 2 + 14));
  };

  const placeButton = () => {
    const el = videoRef.current;
    if (!el || !el.videoWidth || !el.videoHeight) return;
    applyFit(el.videoWidth, el.videoHeight);
  };

  useEffect(() => {
    placeButton();
    const onResize = () => placeButton();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, v.id]);

  /** null = 还不知道画幅；竖屏剧（<2/3 的片子）不显示「全屏观看」 */
  const [portrait, setPortrait] = useState<boolean | null>(null);
  /** 原生层已经回报过片子尺寸：封面可以撤了 */
  const [nativeReady, setNativeReady] = useState(false);
  const [btnTop, setBtnTop] = useState<number | null>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const [qOpen, setQOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{ x: number; url: string; time: number; dx?: number } | null>(null);
  /** 正在拖进度条：铺出红果那种「缩略帧 + 大号时间 + 宽轨道」浮层 */
  const [scrubbing, setScrubbing] = useState(false);
  /** 松手跳转后到真正接上画面之前，给个加载符号（别让人对着静帧干等） */
  const [seeking, setSeeking] = useState(false);
  const seekingRef = useRef(false);
  const seekDoneTimer = useRef(0);
  const frameSub = useRef(false);
  const frameGrabRef = useRef<FrameGrabber | null>(null);
  const [speedHint, setSpeedHint] = useState('');
  const [descOpen, setDescOpen] = useState(false);

  const total = v.episode_count || v.total_episodes || 1;
  const heat = v.hot_count ?? v.counts?.hot ?? 0;
  const favN = v.collect_count ?? v.counts?.collect ?? 0;
  const likeN = v.like_count ?? v.counts?.like ?? 0;
  // 首页来自 /api/feed/random，上游不给评论数：缺就按需补一次详情
  const cmtN = useCommentCount(v, active);

  // 原生模式：占位 div 拿尺寸，videoRef 指向原生播放器的「皮」
  // 注意：ref 回调必须是稳定引用，否则每次 re-render 都会解绑→重绑，
  // 一 destroy 就会把已注册的原生事件订阅全部弄丢（尺寸/时长/竖屏判断全失效）
  const bindNative = useCallback((node: HTMLDivElement | null) => {
    if (!nativeElRef.current) nativeElRef.current = new NativeEl('feed', 'contain');
    const ne = nativeElRef.current;
    if (node) {
      ne.host = node;
      ne.fit = 'contain';
      if (!frameSub.current) {
        frameSub.current = true;
        // 原生层抓帧回来了：拖进度条时的大预览图换成真实画面
        ne.on('frame', () => {
          // 帧回来了只换图和时间，横向位置必须保持在手指下面
          setPreview((p) => ({ x: p?.x ?? 50, url: ne.frameUrl, time: ne.frameTime }));
        });
      }
    } else {
      ne.host = null;
    }
    videoRef.current = ne;
  }, []);

  /** 进度/落库都走这里：H5 的 onTimeUpdate 与原生 timeupdate 共用 */
  const trackTime = (el: any) => {
    if (suspend) return;
    // 正在拖进度条：进度只能听手指的，timeupdate 一掺和就是"疯狂跳蹿"
    if (dragRef.current) return;
    // 时间在往前走 = 跳转已经接上了，加载指示可以撤
    if (seekingRef.current) {
      seekingRef.current = false;
      setSeeking(false);
    }
    setTime(el.currentTime);
    setDur(el.duration || 0);
    setProgress(el.duration ? (el.currentTime / el.duration) * 100 : 0);
    // 时间真的在往前走 = 缓冲结束，撤掉转圈
    if (bufRef.current && el.currentTime > lastAdvance.current + 0.15) setBuf(false);
    if (el.currentTime > lastAdvance.current) lastAdvance.current = el.currentTime;
    // 首页刷到的也算看过：写本地进度 + 历史，下次从任何入口进来都接着播
    const now = Date.now();
    if (el.duration && now - saveAt.current > 5000) {
      saveAt.current = now;
      saveProgress(v.id, ep, el.currentTime, el.duration);
      addHistory(v, ep);
    }
  };

  // 只给"当前那部"挂 video，滑走立刻销毁
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let cancelled = false;
    const offs: Array<() => void> = [];

    if (!active) {
      playerRef.current?.destroy();
      playerRef.current = null;
      setPaused(true);
      setReady(false);
      setPainted(false);
      setNativeReady(false);
      setBuf(false);
      lastAdvance.current = 0;
      try {
        el.pause();
      } catch {
        /* noop */
      }
      return;
    }

    (async () => {
      try {
        el.muted = muted;
        // 只有真的换了剧/集才重置「已出画面」：从播放页退回同一集时，
        // 封面和转圈都不能闪一下（那会像「重新加载」）。
        const key = `${v.id}:${ep}:${quality}`;
        const changed = lastKeyRef.current !== key;
        lastKeyRef.current = key;
        if (changed) {
          // 换剧/换集：上一部的画面已经没了，先按「还没出帧」处理（亮色下不能露黑块）
          setPainted(false);
          setNativeReady(false);
          setReady(false);
          lastAdvance.current = 0;
        }
        setBuf(false);
        // 切频道回来先销毁旧实例，避免两个 hls 抢同一个元素导致播放失败
        const showKey = `${v.id}:${ep}`;
        // 同一集只换清晰度：新流要从当前时间接上，不能退回存档/0
        const keepT = lastShowRef.current === showKey ? el.currentTime || 0 : 0;
        lastShowRef.current = showKey;
        // 这一集有没有第二条 HEVC 流：没有就不让 1080 选项出现，
        // 也绝不把「1080 已切换」的提示挂在一条实际是 720 的流上。
        const bundle = await resolvePlay(v.id, ep);
        const hevcOk = canPlayHevc() && hasHevcStream(bundle.manifest);
        setHasHevc(hevcOk);
        const actual: QualityKey = quality === 'hevc' && hevcOk ? 'hevc' : 'main';
        setEffQuality(actual);
        playerRef.current?.destroy();
        playerRef.current = null;
        playerRef.current = await attachStream(el, v.id, ep, () => {
            if (actual !== 'main' && onPickQuality) {
              onPickQuality('main');
              return;
            }
            setFailed(true);
          }, actual);
        if (cancelled) return;
        if (nativeMode && el instanceof NativeEl) {
          const ne = el;
          offs.push(
            ne.on('timeupdate', () => trackTime(ne)),
            ne.on('loadedmetadata', () => {
              const w = ne.videoWidth, h = ne.videoHeight;
              if (w && h) setPortrait(h >= w);
              setNativeReady(true);
              applyFit(w, h);
            }),
            ne.on('waiting', () => setBuf(true)),
            ne.on('playing', () => {
              setBuf(false);
              setNativeReady(true);
              setPainted(true);
              setPaused(false);
            }),
            ne.on('play', () => setPaused(false)),
            ne.on('pause', () => setPaused(true)),
            ne.on('ended', () => {
              if (!suspend) onAdvance();
            }),
            ne.on('error', () => {
              if (actual !== 'main' && onPickQuality) onPickQuality('main');
              else setFailed(true);
            }),
          );
        }
        await el.play().catch(() => undefined);
        // 回到首页时接着上次的位置播（从详情/播放页/全屏回来都保留进度）。
        // 如果原生播放器里还在播这一集，就直接用它当前的位置，别按存档往回倒。
        const lp = livePlayback();
        const saved = getProgress(v.id);
        const resumeAt =
          keepT > 2
            ? keepT
            : lp && lp.vid === String(v.id) && lp.ep === ep && lp.t > 2
              ? lp.t
              : saved && saved.ep === ep && saved.t > 5 && saved.dur && saved.t < saved.dur - 5
                ? saved.t
                : 0;
        if (resumeAt > 2) {
          const seek = () => {
            try {
              el.currentTime = resumeAt;
            } catch {
              /* noop */
            }
          };
          el.addEventListener('loadedmetadata', seek, { once: true });
          window.setTimeout(seek, 700);
        }
        if (!cancelled) {
          setReady(true);
          setPaused(el.paused);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      playerRef.current?.destroy();
      playerRef.current = null;
      // 换剧/换集：预览解码器也得换，不然它还在解上一部片子
      frameGrabRef.current?.dispose();
      frameGrabRef.current = null;
      window.clearTimeout(seekDoneTimer.current);
      seekingRef.current = false;
      setSeeking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, v.id, ep, quality]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted]);

  /**
   * 不在这一屏的视频一律不许出声、不许在后台跑。
   * 之前从别的入口的播放页退出来，首页那一屏会被外部 play() 重新拉起来在后台响，
   * 这里挂一道闸：只要不是当前那屏，谁来 play() 都立刻按回去。
   */
  useEffect(() => {
    const el: any = videoRef.current;
    if (!el || isNativeEl(el)) return;
    const guard = () => {
      if (active) return;
      try {
        el.pause();
      } catch {
        /* noop */
      }
      try {
        el.muted = true;
      } catch {
        /* noop */
      }
    };
    el.addEventListener('play', guard);
    guard();
    return () => el.removeEventListener('play', guard);
  }, [active]);

  const showFlash = (txt: string) => {
    setFlash(txt);
    window.setTimeout(() => setFlash(''), 650);
  };

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => undefined);
      setPaused(false);
      showFlash('▶');
    } else {
      el.pause();
      setPaused(true);
      showFlash('❚❚');
    }
  }, []);

  // ---------------------------------------------------------------- 进度条

  const ratioAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || !r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  /** 拖进度条时的预览抓帧：原生的走原生独立解码器，网页的走独立解码实例（都不碰正在播的这个） */
  const grabPreview = (at: number, final: boolean) => {
    const el: any = videoRef.current;
    if (!el) return;
    if (isNativeEl(el)) {
      el.capture(at);
      return;
    }
    if (!frameGrabRef.current) frameGrabRef.current = new FrameGrabber(v.id, ep, effQuality);
    const g = frameGrabRef.current;
    const put = (url: string, t: number) =>
      setPreview((p) => ({ x: p?.x ?? 50, url, time: t, dx: p?.dx }));
    if (final) g.flush(at, put);
    else g.push(at, put);
  };

  /**
   * 拖动中（final=false）只更新进度和预览，绝不动主播放器 ——
   * 一拖动就 seek 会把它打进重新缓冲，松手后就是「停一下还没加载符」。
   */
  const seekTo = (ratio: number, final = false) => {
    const el = videoRef.current;
    if (!el || !el.duration) return;
    const at = ratio * el.duration;
    setTime(at);
    setProgress(ratio * 100);
    grabPreview(at, final);
    if (!final) return;
    try {
      el.currentTime = at;
    } catch {
      /* noop */
    }
    // 跳过去到真正出画面之间可能有缓冲空档：立刻给转圈，别出现"停顿且无任何指示"
    seekingRef.current = true;
    setSeeking(true);
    window.clearTimeout(seekDoneTimer.current);
    seekDoneTimer.current = window.setTimeout(() => {
      seekingRef.current = false;
      setSeeking(false);
    }, 4000);
  };

  const drawPreview = (ratio: number, clientX: number) => {
    const el = videoRef.current;
    const track = trackRef.current;
    const cv = canvasRef.current;
    if (!el || !track || !cv || !el.duration) return;
    const now = Date.now();
    if (now - lastPreview.current < 90) return;
    lastPreview.current = now;
    cv.width = 160;
    cv.height = 90;
    try {
      cv.getContext('2d')?.drawImage(el, 0, 0, 160, 90);
    } catch {
      return;
    }
    const r = track.getBoundingClientRect();
    setPreview({ x: clientX - r.left, url: cv.toDataURL('image/jpeg', 0.6), time: ratio * el.duration });
  };

  /** 预览浮层始终跟着手指走（原生模式抓帧慢，也不能让浮层卡住不动） */
  const placePreview = (clientX: number, ratio: number) => {
    const el = videoRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const r = track.getBoundingClientRect();
    const x = Math.min(Math.max(24, clientX - r.left), Math.max(24, r.width - 24));
    // 手指离屏幕中线多远，浮层就平移多远（左右各留出卡片一半，防出界）
    const mid = window.innerWidth / 2;
    const lim = Math.max(0, mid - 100);
    const dx = Math.max(-lim, Math.min(lim, clientX - mid));
    setPreview((p) => ({ x, url: p?.url || '', time: ratio * (el.duration || 0), dx }));
  };

  const onTrackDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = true;
    hoverFrom.current = null;
    setScrubbing(true);
    const ratio = ratioAt(e.clientX);
    seekTo(ratio);
    placePreview(e.clientX, ratio);
  };

  const onTrackMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const ratio = ratioAt(e.clientX);
    if (dragRef.current) {
      seekTo(ratio);
      placePreview(e.clientX, ratio);
      return;
    }
    if (!desktop) return;
    // PC：悬停实时预览（先记原位置，移开再恢复）
    const el = videoRef.current;
    if (el) {
      if (hoverFrom.current === null) hoverFrom.current = el.currentTime;
      try {
        el.currentTime = ratio * el.duration;
      } catch {
        /* noop */
      }
    }
    drawPreview(ratio, e.clientX);
  };

  const onTrackUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (dragRef.current) {
      dragRef.current = false;
      // 松手这一下才真正跳转（拖动中只看预览，不动主播放器）
      seekTo(ratioAt(e.clientX), true);
    }
    setScrubbing(false);
    // 松手必须把预览收掉，否则它会一直卡在屏幕左下角消不掉
    setPreview(null);
    if (hoverFrom.current !== null) {
      // 拖动结束后保持在新位置
      hoverFrom.current = null;
    }
  };

  const onTrackLeave = () => {
    if (dragRef.current) return;
    setScrubbing(false);
    setPreview(null);
    const el = videoRef.current;
    if (hoverFrom.current !== null && el) {
      try {
        el.currentTime = hoverFrom.current;
      } catch {
        /* noop */
      }
      hoverFrom.current = null;
    }
    setPreview(null);
  };

  // ---------------------------------------------------------------- 手势

  const onStageClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // 刚滑过一屏不算点击（否则松手会把新视频立刻暂停）
    const swipedAt = (window as any).__hgSwiped as number | undefined;
    if (swipedAt && performance.now() - swipedAt < 320) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      if (!liked) onLike();
      setHeart(true);
      window.setTimeout(() => setHeart(false), 700);
      return;
    }
    lastTap.current = now;
    window.setTimeout(() => {
      if (lastTap.current === now) togglePlay();
    }, 300);
  };

  const startPress = () => {
    if (desktop) return;
    pressActive.current = false;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      const el = videoRef.current;
      if (!el) return;
      pressActive.current = true;
      suppressClick.current = true;
      el.playbackRate = 2;
      setSpeed(2);
      setSpeedHint('2.0 倍数快进中 · 上滑锁定');
    }, 380);
  };

  const movePress = (e: React.PointerEvent) => {
    if (!pressActive.current || speedLocked.current) return;
    const startY = (e.currentTarget as HTMLElement).dataset.startY;
    if (startY === undefined) return;
    if (Number(startY) - e.clientY > 40) {
      speedLocked.current = true;
      setSpeedHint('已锁定 2.0 倍速 · 点击画面解锁');
    }
  };

  const endPress = () => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (pressActive.current && !speedLocked.current) {
      const el = videoRef.current;
      if (el) el.playbackRate = 1;
      setSpeed(1);
      setSpeedHint('');
    }
    pressActive.current = false;
  };

  const unlockSpeed = () => {
    const el = videoRef.current;
    if (el) el.playbackRate = 1;
    speedLocked.current = false;
    setSpeed(1);
    setSpeedHint('');
  };

  // ---------------------------------------------------------------- 全屏

  const toggleFullscreen = async () => {
    const el = slideRef.current;
    try {
      if (!document.fullscreenElement) await el?.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch {
      onToast('当前环境不支持全屏');
    }
  };

  return (
    <section
      className={`slide${active ? ' active' : ''}`}
      data-idx={index}
      ref={slideRef}
      style={idxStyle}
    >
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <Danmaku lines={danmaku} />

      <div
        ref={stageRef}
        className="slide-stage"
        onClick={onStageClick}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).dataset.startY = String(e.clientY);
          startPress();
        }}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
      >
        {/* 封面只在视频就绪前露出：视频 ready 后隐藏，避免黑边区域显示封面。
            「没播过的那一屏」始终显示自己的封面（滑动过程里它还是预览态），
            一旦播过（fit 有值）就不再露封面 —— 否则滑走后旧封面会被当成
            「上一个剧的残影」留在屏幕上。 */}
        <img
          src={coverUrl(v.cover)}
          alt={v.title}
          loading={index < 3 ? 'eager' : 'lazy'}
          style={{
            opacity: active
              ? fit || (nativeMode && (nativeReady || ready))
                ? 0
                : 1
              : fit
                ? 0
                : 1,
            transition: active ? 'opacity 0.18s linear' : 'none',
          }}
        />
        {active && (nativeMode ? (
          <div
            ref={bindNative}
            className="vid nstage"
            style={
              fit
                ? {
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: fit.w,
                    height: fit.h,
                    transform: 'translate(-50%, -50%)',
                  }
                : undefined
            }
          />
        ) : (
          <video
            ref={videoRef}
            className="vid"
            data-hg-feed="1"
            data-hg-vid={String(v.id)}
            data-hg-ep={String(ep)}
            /* 首帧没画出来之前这层是不透光的黑块：亮色主题下要按这个标记先藏起来，
               暗色主题不受影响（黑底本来就看不出来）。 */
            data-painted={painted ? '1' : '0'}
            style={
              fit
                ? {
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: fit.w,
                    height: fit.h,
                    transform: 'translate(-50%, -50%)',
                    objectFit: 'fill',
                  }
                : undefined
            }
            playsInline
            muted={muted}
            preload="auto"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              setPortrait(!!el.videoWidth && el.videoHeight >= el.videoWidth);
              placeButton();
            }}
            onTimeUpdate={(e) => trackTime(e.currentTarget)}
            /* loadeddata = 首帧已经解出来了；playing 兜一道，防止个别机型不报 loadeddata */
            onLoadedData={() => setPainted(true)}
            onWaiting={() => setBuf(true)}
            onPlaying={() => {
              setBuf(false);
              setPainted(true);
              setPaused(false);
            }}
            onEnded={suspend ? undefined : onAdvance}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
          />
        ))}
        {!ready && !failed && active && <div className="stage-loading">加载中…</div>}
        {/* 真实在缓冲（waiting）给个转圈：从播放页退回来/网络抖动时，别只有静止画面 */}
        {ready && buffering && !failed && active && !(nativeMode && !nativeReady) && (
          <div className="seek-spin">
            <span className="hg-spin" />
          </div>
        )}
        {/* 松手跳转后的缓冲空档：只叠一个转圈，不盖黑底，免得闪一下 */}
        {ready && seeking && !failed && active && (
          <div className="seek-spin">
            <span className="hg-spin" />
          </div>
        )}
        {flash && <div className="centerflash show">{flash}</div>}
        {heart && <div className="heartpop">♥</div>}
        <button
          type="button"
          className="mutebtn"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
          }}
          aria-label={muted ? '取消静音' : '静音'}
        >
          <Icon name={muted ? 'mute' : 'vol'} size={15} strokeWidth={1.9} />
        </button>
      </div>

      {portrait === false && (
        <button type="button" className="fsbtn" style={btnTop != null ? { top: btnTop } : undefined} onClick={() => onLandscape(v, ep, videoRef.current?.currentTime || 0)}>
          <Icon name="fullscreen" size={20} strokeWidth={2} />
          全屏观看
        </button>
      )}

      <div className="rail">
        <button type="button" className={`rail-item star${faved ? ' on' : ''}`} onClick={onFav}>
          <Icon name={faved ? 'starFill' : 'star'} size={28} strokeWidth={1.4} />
          <span className="n">{fmtNum(favN + (faved ? 1 : 0))}</span>
        </button>
        <button type="button" className="rail-item" onClick={() => onComment(v)}>
          <Icon name="chat" size={28} strokeWidth={1.7} />
          <span className="n">{fmtNum(cmtN)}</span>
        </button>
        <button type="button" className={`rail-item${liked ? ' on' : ''}`} onClick={onLike}>
          <Icon name={liked ? 'heartFill' : 'heart'} size={28} strokeWidth={1.7} />
          <span className="n">{fmtNum(likeN + (liked ? 1 : 0))}</span>
        </button>
        <button type="button" className="rail-item" onClick={() => onShare(v, 1)}>
          <Icon name="share" size={28} strokeWidth={1.8} />
          <span className="n">分享</span>
        </button>
      </div>

      <div className="slide-bottom">
        <div className="slide-title" onClick={() => onDetail(v.id)}>
          <span>{v.title}</span>
          <Icon name="chevron" size={16} strokeWidth={2.2} />
        </div>

        <div className="tagrow">
          <span className="tag heat">
            <Icon name="fire" size={12} strokeWidth={2} />
            {fmtHeat(heat)}
          </span>
          {(v.tags || []).slice(0, 2).map((t) => (
            <span className="tag" key={String(t)}>
              {typeof t === 'string' ? t : t?.name}
            </span>
          ))}
        </div>

        <div className={`hotcomment${descOpen ? ' open' : ''}`} onClick={() => setDescOpen((x) => !x)}>
          <Icon name="fire" size={15} strokeWidth={2} />
          <span className="label">{descOpen ? '简介' : '热评'}</span>
          <span className="txt">
            ｜{descOpen
              ? (v.description || '暂无简介').replace(/\s+/g, ' ')
              : (v.description || '暂无简介').replace(/\s+/g, ' ').slice(0, 22) + '…'}
          </span>
          <span className="more">{descOpen ? '收起' : '展开'}</span>
        </div>

        <div className="authorship">
          <Icon name="info" size={13} strokeWidth={1.9} />
          作者声明：内容由AI生成
        </div>

        <button type="button" className="cta" onClick={() => onOpen(v, ep, videoRef.current?.currentTime || 0)}>
          <span className="l">
            <Icon name="play" size={17} strokeWidth={2} />
            观看完整剧情·全{total}集
          </span>
          <Icon name="chevron" size={17} strokeWidth={2} />
        </button>
      </div>

      {/* 可拖动进度条：拖动中由它自己变粗跟手，浮层里不再另起一条，省得看见两根 */}
      <div
        className={`slide-progress${scrubbing ? ' scrubbing' : ''}`}
        ref={trackRef}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onPointerCancel={onTrackUp}
        onPointerLeave={onTrackLeave}
      >
        <i style={{ width: `${active ? progress : 0}%` }} />
        {/* 小预览只在 PC 悬停时出现；手机上一律用下面的大浮层，避免残留 */}
        {desktop && preview && !scrubbing && (
          <div className="seekpreview" style={{ left: preview.x }}>
            <img src={preview.url} alt="" />
            <span>{fmtDuration(preview.time)}</span>
          </div>
        )}
      </div>

      {/* 拖进度条时的预览浮层：缩略帧 + 大号时间 + 宽轨道（对照红果） */}
      {scrubbing && dur > 0 && (
        <div className="scrubpanel">
          <div className="scrub-follow" style={{ transform: `translateX(${preview?.dx || 0}px)` }}>
            <div className={`scrub-card${preview?.url ? '' : ' empty'}`}>
              {preview?.url ? <img src={preview.url} alt="" /> : <span className="hg-spin tiny" />}
            </div>
            <div className="scrub-time">
              <b>{fmtDuration(time)}</b>
              <span>/{fmtDuration(dur)}</span>
            </div>
          </div>
        </div>
      )}

      {speedHint && (
        <div className="speedhint" onClick={unlockSpeed}>
          {speedLocked.current ? (
            <Icon name="play" size={13} strokeWidth={2} />
          ) : (
            <Icon name="chevron" size={13} strokeWidth={2.4} style={{ transform: 'rotate(-90deg)' }} />
          )}
          {speedHint}
        </div>
      )}

      {/* PC 端底部控制条 */}
      {desktop && (
        <div className="dctl">
          <button type="button" className="dctl-btn" onClick={togglePlay} aria-label="播放/暂停">
            <Icon name={paused ? 'play' : 'pause'} size={20} strokeWidth={2} />
          </button>
          <span className="dctl-time">
            {fmtDuration(time)} / {fmtDuration(dur)}
          </span>
          <span className="dctl-sp" />
          {onPickQuality && (
            <div className="qwrap">
              <button type="button" className="dctl-btn" onClick={() => setQOpen((o) => !o)}>
                {QUALITY_LABEL[effQuality].replace('高清 ', '').replace('超清 ', '').replace('（HEVC）', '')}
              </button>
              {qOpen && (
                <div className="qmenu">
                  {availableQualities()
                    .filter((q) => q === 'main' || hasHevc)
                    .map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={q === effQuality ? 'on' : ''}
                      onClick={() => {
                        if (q === effQuality) {
                          setQOpen(false);
                          return;
                        }
                        onPickQuality(q);
                        setQOpen(false);
                        onToast(`已切换到 ${QUALITY_LABEL[q]}`);
                      }}
                    >
                      {QUALITY_LABEL[q]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="dctl-btn"
            onClick={() => (onPickEpisode ? onPickEpisode(v) : onDetail(v.id))}
          >
            <Icon name="bullet" size={16} strokeWidth={1.9} />
            第{ep}集 · 选集·全{total}集
          </button>
          <button
            type="button"
            className="dctl-btn"
            onClick={() => {
              const next = speed >= 2 ? 0.75 : Number((speed + 0.25).toFixed(2));
              setSpeed(next);
              const el = videoRef.current;
              if (el) el.playbackRate = next;
            }}
          >
            {speed.toFixed(2).replace(/\.00$/, '.0')}x
          </button>
          <button type="button" className="dctl-btn" onClick={onToggleMute}>
            <Icon name={muted ? 'mute' : 'vol'} size={17} strokeWidth={1.9} />
          </button>
          <button type="button" className="dctl-btn" onClick={toggleFullscreen}>
            <Icon name="fullscreen" size={17} strokeWidth={1.9} />
          </button>
        </div>
      )}
    </section>
  );
}
