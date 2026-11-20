import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Video } from '../data/types';
import { coverUrl, playErrorText } from '../data/api';
import {
  attachStream,
  canPlayHevc,
  defaultQuality,
  findLiveFeedVideo,
  hasHevcStream,
  pauseFeedVideos,
  QUALITY_LABEL,
  availableQualities,
  resolvePlay,
  type AttachedPlayer,
  type QualityKey,
} from '../core/player';
import { NativeEl, engine, isNativeEl, livePlayback, nativeMode } from '../core/native';
import { FrameGrabber } from '../core/preview';
import { useLongPressBoost } from '../core/boost';
import { addHistory, getProgress, setProgress } from '../core/store';
import { auth, getToken } from '../core/auth';
import { isFav, isLiked, subscribeMarks, toggleFav, toggleLike } from '../core/marks';
import { fmtDuration, fmtNum } from '../lib/format';
import { useCommentCount } from '../core/useCommentCount';
import { Icon } from './Icons';
import { ScrubTip } from './ScrubTip';
import { EpisodePlayerPC } from './EpisodePlayerPC';
import { useIsDesktop } from '../core/useDesktop';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2, 3];
const RANGE = 30;

/**
 * 手机端「观看完整剧情」播放页：
 *  顶部：返回 / 第N集 / 倍速 / 更多
 *  中部：视频撑满可用高度
 *  下部：标题（点进详情）+ 第N集｜简介（可展开）+ 作者声明
 *  底部：进度条 + 「选集·已完结·全N集」胶囊 + 清屏
 *
 * 两种播放模式：
 *  - borrow：从首页那一屏点进来，且是同一部同一集 → 直接借用首页正在播的 <video>，
 *    不重建播放器、不重新缓冲，画面零中断（首页自己的进度条/按钮会被藏掉）。
 *  - own：其他所有入口（剧场/榜单/搜索/我的/详情）→ 播放页自己播这一部。
 *    一旦在 borrow 里换了集，也会立刻切到 own，避免把首页那部播成别的集数。
 */
export function EpisodePlayer({
  video,
  ep,
  onClose,
  startAt,
  feed = false,
  suspend = false,
  onDetail,
  onComment,
  onShare,
  onToast,
  onLandscape,
  onStageVideo,
  onExit,
  sync = null,
}: {
  video: Video;
  ep: number;
  onClose: () => void;
  startAt?: number;
  /** true = 从首页那一屏进来的（只有它允许接管首页播放器） */
  feed?: boolean;
  /** true = 上面又压了别的页面：先暂停，别在下面继续放、还有声音 */
  suspend?: boolean;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onToast: (t: string) => void;
  /** 横屏剧才有「全屏观看」：跳横屏播放页 */
  onLandscape?: (v: Video, ep: number, at: number) => void;
  /** 把这一层正在播的 <video> 交出去（进全屏时全屏页用同一个元素，不重新取流） */
  onStageVideo?: (el: HTMLVideoElement | null) => void;
  /** 关闭前回报当前集数：首页要停在同一集 */
  onExit?: (ep: number) => void;
  /** 全屏页退出时交回来的集数/位置：这里接着播，不再从第一集重载 */
  sync?: { ep: number; at: number; k: number } | null;
}) {
  const total = Math.max(1, video.episode_count || video.total_episodes || 1);
  const initEp = Math.min(Math.max(1, ep || getProgress(video.id)?.ep || 1), total);
  const isDesktop = useIsDesktop();

  const videoRef = useRef<any>(null);
  const nativeElRef = useRef<NativeEl | null>(null);
  const playerRef = useRef<AttachedPlayer | null>(null);
  const lastEpRef = useRef(-1);
  const firstLoadRef = useRef(true);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const saveAt = useRef(0);
  const lastTap = useRef(0);
  const suppressClick = useRef(false);
  const touchStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const liveRef = useRef<HTMLVideoElement | null>(null);
  const flashTimer = useRef(0);
  /** 关页时只播报一次「看到第几集」：点返回走 finish，系统返回/被弹出走卸载兜底 */
  const exitedRef = useRef(false);
  const curRef = useRef(0);
  const resumeAfterCover = useRef(false);
  // 拖进度条：目标时间 / 上次抓帧时刻 / 独立预览解码器
  const grabberRef = useRef<FrameGrabber | null>(null);
  const lastGrab = useRef(0);
  const scrubAt = useRef(0);
  // 按下进度条那一刻是否在播：松手后据此决定要不要接着播
  const scrubWasPlaying = useRef(false);
  const [scrubX, setScrubX] = useState(0);

  const [cur, setCur] = useState(initEp);
  // 从首页/榜单点进来时列表里没有评论数，按需补一次（同一部只补一次）
  const cmtN = useCommentCount(video);
  const [mode, setMode] = useState<'borrow' | 'own'>(() => {
    // PC 是独立的播放页布局，不走「借用首页播放器」这套
    if (!feed || isDesktop) return 'own';
    // 原生模式没有可「借」的 <video> 节点：首页那屏是原生纹理，
    // 必须自己 claim 一次，让原生层把画面挪到这个舞台上（同一条流不会重新取）
    if (nativeMode) return 'own';
    const live = findLiveFeedVideo();
    if (!live) return 'own';
    // 必须是同一部、同一集，才敢接管；否则首页那部会被当成这部播出来
    if (Number(live.dataset.hgVid) !== video.id) return 'own';
    if (Number(live.dataset.hgEp || 1) !== initEp) return 'own';
    liveRef.current = live;
    return 'borrow';
  });
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [immersive, setImmersive] = useState(false);
  const [showEps, setShowEps] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const [range, setRange] = useState(Math.floor((initEp - 1) / RANGE));
  // 长按画面 = 临时 2 倍速；松手回到用户自己选的那一档
  const [boostOn, setBoostOn] = useState(false);
  const hold = useLongPressBoost({
    speed: () => speed,
    apply: (r) => {
      const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
      if (el) el.playbackRate = r;
    },
    onToggle: (on) => {
      setBoostOn(on);
      const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
      if (on && el?.paused) {
        try {
          void el.play();
        } catch {
          /* noop */
        }
      }
    },
  });
  // 收藏/点赞走全局状态（与首页、详情页、我的页是同一份），点了立刻刷新
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);
  const [tip, setTip] = useState('');
  /** 播放页默认就有声音：不再有「点一下开启声音」那层提示，也没有静音键 */
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState<QualityKey>(defaultQuality());
  /** 实际挂上去的流：这一集没有 hevc 时虽然选了「1080」，真实播的还是 main */
  const [effQuality, setEffQuality] = useState<QualityKey>(quality);
  /** 当前这一集上游到底有没有第二条 HEVC 流（没有就不显示 1080 选项） */
  const [hasHevc, setHasHevc] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  /**
   * 全屏观看：不再新开一个页面/播放器，就在这一层把画面铺满整屏。
   * 同一个 <video>、同一个播放器实例，只是尺寸和 UI 换一套 —— 进出全屏都不重载、不丢集数。
   */
  const [fs, setFs] = useState(false);
  /** 浏览器不支持锁横屏时，整块转 90° 兜底 */
  const [fsRotated, setFsRotated] = useState(false);
  const fsRot = fs && fsRotated;
  const [volPct, setVolPct] = useState<number | null>(null);
  const fsGest = useRef({ mode: 'idle' as 'idle' | 'seek' | 'vol', x: 0, y: 0, base: 0, w: 0, h: 0, vol0: 1, moved: false, ui0: true });
  const fsSeekTo = useRef(0);
  const fsTapAt = useRef(0);
  const fsTapTimer = useRef(0);
  const fsHideT = useRef(0);
  const [flashEp, setFlashEp] = useState('');
  // cur 同步进 ref：卸载兜底（系统返回）时要拿到最新那一集
  useEffect(() => {
    curRef.current = cur;
  }, [cur]);
  useEffect(() => {
    return () => {
      if (exitedRef.current) return;
      exitedRef.current = true;
      try {
        const el: any = liveRef.current || videoRef.current;
        if (el && el.duration) setProgress(video.id, curRef.current, el.currentTime, el.duration);
      } catch {
        /* noop */
      }
      onExit?.(curRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 原生层已经出画面了：可以撤封面 */
  const [nready, setNready] = useState(false);
  // 缓冲/取流中：中央显示转圈，而不是一个看着像「已就绪」的播放三角
  const [loading, setLoading] = useState(true);
  /** 正在拖进度条：浮出预览 */
  const [scrubbing, setScrubbing] = useState(false);
  /**
   * 松手后的一小段"续播观察期"：这段时间内不显示中央播放三角。
   * 拖动是自动续播的，用户没点暂停；只有真的续不上（700ms 后还是暂停态）才把按钮亮出来。
   */
  const [scrubTail, setScrubTail] = useState(false);
  const scrubTailT = useRef(0);
  /**
   * 拖动开始时我们自己把画面 pause 掉了：这期间来的 pause 事件不算「用户暂停」，
   * 否则中央会立刻顶出一个播放三角，看着就像误触了暂停。
   */
  const scrubPauseRef = useRef(false);
  const markPaused = () => {
    if (scrubPauseRef.current) return;
    setPaused(true);
  };
  /**
   * 中央按钮只该表达两件事：用户在不在「自己按了暂停」，系统在不在加载。
   * paused 这个播放器状态会被拖动/切入/缓冲顺手改成 true，拿它当按钮依据就会出现
   * 「明明在加载，却顶着一个播放三角」的误导。所以这里单独记住是不是用户按的。
   */
  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);
  /** 进入播放页的时刻：用来吃掉「点进来那一下」漏进来的点击 */
  const openAt = useRef(Date.now());
  /** 被别的页面盖住时不许自动续播（pause 事件的兜底要认这个） */
  const suspendRef = useRef(false);
  useEffect(() => {
    suspendRef.current = suspend;
  }, [suspend]);
  /** 缓冲看门狗：连续两次 readyState < 3 才认定卡住，避免正常播放时闪转圈 */
  const stallTicks = useRef(0);
  useEffect(() => {
    userPausedRef.current = userPaused;
  }, [userPaused]);
  /**
   * 加载符号兜底：部分内核（尤其 WebView / 原生桥）拖完进度、切集时不会抛 waiting，
   * 结果就是「真实在缓冲，但界面既不转圈也不显示暂停，只剩画面顿住」。
   * 这里直接盯 readyState：连续两拍（约 1s）< 3 才亮转圈，恢复 >= 3 再撤，避免正常播放时闪。
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const el: any = mediaEl();
      if (!el) return;
      if (el.paused) {
        stallTicks.current = 0; // 暂停态由 userPaused 表达，这里不管
        return;
      }
      // 原生层直接按真实缓冲态走（state.buffering），别用 readyState 猜
      if (typeof el.buffering === 'boolean') {
        setLoading(el.buffering);
        return;
      }
      const rs = typeof el.readyState === 'number' ? el.readyState : 4;
      if (rs < 3) {
        stallTicks.current += 1;
        if (stallTicks.current >= 2) setLoading(true);
      } else {
        stallTicks.current = 0;
        setLoading(false);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  // 拖动期间不接受播放器的进度回调，否则进度条会被主播放器拽回去
  const scrubOn = useRef(false);
  const [frame, setFrame] = useState<{ url: string; time: number } | null>(null);
  /** 上下滑换集：舞台跟手位移 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef({ dy: 0, on: false });
  const [swipeY, setSwipeY] = useState(0);
  /** null = 还没量出画幅；true = 横屏片子（才给「全屏观看」） */
  const [wide, setWide] = useState<boolean | null>(null);
  /** 画幅比（w/h）：用来把「全屏观看」按钮摆在画面正下方 */
  const [ar, setAr] = useState(0);

  /** 量画幅：宽高比超过 1.15 才算横屏，竖屏短剧一律不给全屏入口 */
  const probeAspect = (el: any) => {
    const w = Number(el?.videoWidth || 0);
    const h = Number(el?.videoHeight || 0);
    if (w > 0 && h > 0) {
      setAr(w / h);
      setWide(w / h > 1.15);
    }
  };

  const onFatal = () => {
    if (quality !== 'main') {
      setTip('本机解不了 1080P，已切回 720P');
      setQuality('main');
    } else {
      setTip('播放中断，正在重试…');
    }
  };

  // ------------------------------------------------------------ 进度落库

  const persist = (n: number, el: HTMLVideoElement) => {
    const d = el.duration;
    if (!d || !Number.isFinite(d)) return;
    setProgress(video.id, n, el.currentTime, d);
    addHistory(video, n);
  };

  const saveTick = (n: number, el: HTMLVideoElement | any) => {
    const now = Date.now();
    if (now - saveAt.current < 5000) return;
    saveAt.current = now;
    persist(n, el);
  };

  /** 退出播放页：先把这一集看到哪落库，再把集数交回首页（首页要停在同一集） */
  const finish = () => {
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    try {
      if (el && el.duration) {
        setProgress(video.id, cur, el.currentTime, el.duration);
        addHistory(video, cur);
      }
    } catch {
      /* noop */
    }
    exitedRef.current = true; // 卸载兜底别重复播报
    onExit?.(cur);
    onClose();
  };

  // 把这一层正在播的 <video> 交给外面：全屏页接过去继续用同一个元素，不重新取流
  useEffect(() => {
    if (!onStageVideo) return;
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    if (el && !isNativeEl(el)) onStageVideo(el);
    return () => onStageVideo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, video.id, cur]);

  // 全屏里换了集，退出时交回来：换集就走正常换集流程，同集就只把位置对上
  const syncSeek = useRef(0);
  useEffect(() => {
    if (!sync) return;
    if (sync.ep !== cur) {
      syncSeek.current = sync.at > 1 ? sync.at : 0;
      setCur(sync.ep);
      return;
    }
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    try {
      if (el && sync.at > 1) el.currentTime = sync.at;
    } catch {
      /* noop */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync?.k]);

  // ------------------------------------------------------------ 换集

  const showFlash = (n: number) => {
    setFlashEp(`第 ${n} 集`);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashEp(''), 900);
  };

  const goEp = (n: number) => {
    const next = Math.min(total, Math.max(1, n));
    if (next === cur) return;
    // 借来的首页播放器只服务它自己那一集，换集就把播放权交还给播放页
    if (mode === 'borrow') {
      const live = liveRef.current;
      if (live) {
        try {
          live.pause();
        } catch {
          /* noop */
        }
      }
      liveRef.current = null;
      setMode('own');
    }
    setCur(next);
    setRange(Math.floor((next - 1) / RANGE));
    setTime(0);
    setDur(0);
    setPaused(false);
    setLoading(true);
    setUserPaused(false);
    showFlash(next);
  };

  // ------------------------------------------------------------ borrow：接管首页正在播的那个

  useEffect(() => {
    if (mode !== 'borrow') return;
    const el = liveRef.current;
    if (!el) {
      setMode('own');
      return;
    }
    // 播放页默认有声：把借来的这条也打开声音；退出时按 wasMuted 还给首页
    const wasMuted = el.muted;
    el.muted = false;
    setMuted(false);
    el.play().catch(() => undefined);
    setPaused(el.paused);
    // 借来的这条已经在首页播着：先按「加载中」显示，等真的接上画面再撤，
    // 别一进来就把播放三角亮出来（用户没暂停过，他只是在等画面）
    setLoading(true);
    el.play()
      .then(() => {
        if (el.readyState >= 3) setLoading(false);
        setPaused(false);
      })
      .catch(() => {
        setLoading(false);
      });
    const n = cur;
    const onTime = () => {
      if (scrubOn.current) return; // 正在拖：进度条由手指决定
      setTime(el.currentTime);
      if (el.duration && Number.isFinite(el.duration)) setDur(el.duration);
      saveTick(n, el);
    };
    const onMeta = () => setDur(el.duration || 0);
    const onPlay = () => {
      setPaused(false);
      setUserPaused(false);
      // 不在这里撤转圈：刚接管/刚换集的 play 往往还没吃到数据
    };
    const onPause = () => {
      markPaused();
      // 不是用户按的暂停（首页收起、外部逻辑顺手 pause 了它）：立刻自己接回来，
      // 别让画面真停在那儿、还等一次点击才动。
      if (suspendRef.current || userPausedRef.current || scrubPauseRef.current) return;
      if (el !== liveRef.current) return;
      window.setTimeout(() => {
        if (suspendRef.current || userPausedRef.current || scrubPauseRef.current) return;
        try {
          if (el.paused) el.play()?.catch?.(() => undefined);
        } catch {
          /* noop */
        }
      }, 140);
    };
    const onBusy = () => setLoading(true);
    const onReady = () => {
      if (el.paused) return; // 还没真的播起来就别把转圈撤了
      setLoading(false);
    };
    const onEnd = () => {
      if (n < total) goEp(n + 1);
      else {
        setPaused(true);
        setUserPaused(true);
      }
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('waiting', onBusy);
    el.addEventListener('playing', onReady);
    el.addEventListener('canplay', onReady);
    el.addEventListener('ended', onEnd);
    onTime();
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('waiting', onBusy);
      el.removeEventListener('playing', onReady);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('ended', onEnd);
      // 交还首页时把静音/倍速状态还原，别让首页音量和倍速对不上
      try {
        el.muted = wasMuted;
        el.playbackRate = 1;
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);


  // ------------------------------------------------------------ own：播放页自己播

  /** 原生模式下，把 DOM 占位换成原生播放器的「皮」
   *  ref 回调保持稳定引用：否则每次 re-render 解绑→重绑会 destroy 掉实例，
   *  订阅在旧实例上的原生事件全部收不到 */
  const bindNative = useCallback((node: HTMLDivElement | null) => {
    if (!nativeElRef.current) nativeElRef.current = new NativeEl('player', 'contain');
    const ne = nativeElRef.current;
    if (node) {
      ne.host = node;
      ne.fit = 'contain';
    } else {
      ne.host = null;
    }
    videoRef.current = ne;
  }, []);

  useEffect(() => {
    if (mode !== 'own') return;
    // 首页那些视频先全部停掉，否则会在下面继续放
    pauseFeedVideos();
    const el = videoRef.current;
    if (!el) return;
    let alive = true;
    const offs: Array<() => void> = [];
    setTip('');
    (async () => {
      try {
        // 同一个元素：换清晰度这种不算换集，保留当前进度，别退回上次记录的位置
        const keep = el.currentTime || 0;
        const sameEp = lastEpRef.current === cur;
        // 这一集到底有没有第二条 HEVC 流：没有就老老实实播 main，
        // 不能把「1080」按钮亮着、点了没反应还提示切换成功。
        const bundle = await resolvePlay(video.id, cur);
        const hevcOk = canPlayHevc() && hasHevcStream(bundle.manifest);
        setHasHevc(hevcOk);
        const actual: QualityKey = quality === 'hevc' && hevcOk ? 'hevc' : 'main';
        setEffQuality(actual);
        playerRef.current?.destroy();
        playerRef.current = await attachStream(el, video.id, cur, onFatal, actual);
        if (!alive) return;
        lastEpRef.current = cur;
        el.muted = muted;
        el.playbackRate = speed;
        // 原生播放器不会自己触发 React 的 onXxx，手动接上同一套状态回调
        if (nativeMode && el instanceof NativeEl) {
          const ne = el;
          offs.push(
            ne.on('timeupdate', () => {
              if (scrubOn.current) return; // 正在拖：进度条由手指决定
              setTime(ne.currentTime);
              setDur(ne.duration || 0);
              // 这里绝不能顺手 setLoading(false)：拖动/切集后 timeupdate 会先来，
              // 但画面其实还在缓冲，一撤转圈就变成「不显示加载、画面却顿住」
              saveTick(cur, ne);
            }),
            ne.on('loadedmetadata', () => {
              setDur(ne.duration || 0);
              probeAspect(ne);
            }),
            ne.on('resize', () => probeAspect(ne)),
            ne.on('waiting', () => setLoading(true)),
            ne.on('playing', () => setLoading(false)),
            ne.on('play', () => {
              setPaused(false);
              setUserPaused(false);
              // 同上：play 不等于有画面，转圈交给 waiting/playing/canplay
            }),
            ne.on('pause', () => markPaused()),
            ne.on('ended', () => {
              if (cur < total) goEp(cur + 1);
              else {
                setPaused(true);
                setUserPaused(true);
              }
            }),
            ne.on('error', () => onFatal()),
          );
        }
        const p = getProgress(video.id);
        // 会话里原生还在播这部这一集：就接着它那个位置，别按历史记录往回倒
        const lp = livePlayback();
        const liveT = lp && lp.vid === String(video.id) && lp.ep === cur && lp.t > 2 ? lp.t : 0;
        const want = sameEp && keep > 3
          ? keep
          : syncSeek.current > 1
            ? syncSeek.current
            : liveT > 0
              ? liveT
              : firstLoadRef.current && startAt && startAt > 2
                ? startAt
                : p && p.ep === cur && p.t > 3 && p.dur && p.t < p.dur - 3
                  ? p.t
                  : 0;
        syncSeek.current = 0;
        firstLoadRef.current = false;
        if (want > 1) {
          const seek = () => {
            try {
              el.currentTime = want;
            } catch {
              /* noop */
            }
          };
          el.addEventListener('loadedmetadata', seek, { once: true });
          window.setTimeout(seek, 600);
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
  }, [mode, video.id, cur, quality]);

  // 上面又压了别的页面（详情 / 全屏 / 搜索…）：先停住，别在下面继续放、还有声音。
  // 盖住它的页面退出后自动接着播；但如果暂停前本来就是暂停的，回来也不自作主张开播。
  useEffect(() => {
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    if (!el) return;
    if (suspend) {
      if (!el.paused) {
        resumeAfterCover.current = true;
        try {
          el.pause();
        } catch {
          /* noop */
        }
      }
      return;
    }
    if (resumeAfterCover.current) {
      resumeAfterCover.current = false;
      try {
        el.play?.()?.catch?.(() => undefined);
      } catch {
        /* noop */
      }
    }
  }, [suspend, mode]);

  /**
   * 静默停住的自动纠偏：只要不是「用户自己按了暂停」「正在拖进度条」「被别的页面盖住」，
   * 视频就不该无缘无故停在暂停态（进播放页先停一拍、被首页顺手 pause 掉，都归这里管）。
   * 界面在这期间显示的是转圈，不是播放三角。
   */
  useEffect(() => {
    if (suspend) return;
    const tick = window.setInterval(() => {
      if (scrubOn.current || dragRef.current || userPausedRef.current) return;
      const el2: any = mode === 'borrow' ? liveRef.current : videoRef.current;
      if (!el2 || !el2.paused) return;
      // 还在取流/缓冲：交给中央转圈表达，不要硬起播
      if (typeof el2.readyState === 'number' && el2.readyState < 2) return;
      try {
        el2.play?.()?.catch?.(() => undefined);
      } catch {
        /* noop */
      }
    }, 900);
    return () => window.clearInterval(tick);
  }, [mode, cur, suspend, video.id]);

  // 播放页关掉时，把首页正在播的那条流接回去（原生层是全局复用的）
  useEffect(() => {
    return () => {
      if (nativeMode) engine.release('player');
    };
  }, []);

  // 量画幅：原生层的尺寸回报来得晚，前几秒多探几次
  useEffect(() => {
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    if (!el) return;
    probeAspect(el);
    let n = 0;
    const iv = window.setInterval(() => {
      probeAspect(el);
      if (++n >= 6) window.clearInterval(iv);
    }, 500);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cur]);

  // 播放页一开就把原生层的矩形对齐（页面刚挂上时版式还在变，early sync 一次不够）
  useEffect(() => {
    if (!nativeMode || mode !== 'own') return;
    setNready(false);
    const ids = [60, 220, 520, 900].map((t) => window.setTimeout(() => engine.syncRect(true), t));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [mode, cur]);

  // 原生层真正渲出第一帧（ff）才撤封面垫层；迟迟不来就兜底撤掉，别一直挡着画面
  useEffect(() => {
    const el: any = videoRef.current;
    if (!el || !(el instanceof NativeEl)) return;
    setNready(false);
    let done = false;
    const kill = () => {
      if (done) return;
      done = true;
      setNready(true);
    };
    const t = window.setTimeout(kill, 4000);
    const offFirst = el.on('firstframe', kill);
    const offMeta = el.on('loadedmetadata', () => {
      if (!done) window.setTimeout(kill, 400);
    });
    // 拖进度条时原生层回抓的帧
    const offFrame = el.on('frame', () => setFrame({ url: el.frameUrl, time: el.frameTime }));
    return () => {
      offFirst();
      offMeta();
      offFrame();
      window.clearTimeout(t);
    };
  }, [mode, cur, video.id]);

  // 网页内核里同一个 <video> 换 src 时会保留上一帧，封面必须先垫住，等新流真正出画再撤
  useEffect(() => {
    if (nativeMode || mode !== 'own') return;
    setNready(false);
    const el = videoRef.current;
    if (!el) return;
    let done = false;
    const kill = () => {
      if (done) return;
      done = true;
      setNready(true);
    };
    el.addEventListener('loadeddata', kill);
    el.addEventListener('playing', kill);
    const t = window.setTimeout(kill, 2600);
    return () => {
      el.removeEventListener('loadeddata', kill);
      el.removeEventListener('playing', kill);
      window.clearTimeout(t);
    };
  }, [mode, cur, video.id, quality, nativeMode]);

  useEffect(() => {
    const el = videoRef.current;
    if (el && mode === 'own') el.muted = muted;
  }, [muted, mode]);

  // ------------------------------------------------------------ 交互

  const togglePlay = () => {
    // 刚点进来那一下点击会漏到画面上（真机 WebView 的 tap 合成 click 落到新挂载的舞台），
    // 这一下绝不能当成「用户暂停」，否则一进页面就真暂停、还挂着暂停符。
    if (Date.now() - openAt.current < 520) return;
    const el = mode === 'borrow' ? liveRef.current : videoRef.current;
    if (!el) return;
    if (el.paused) {
      // 用户亲自点了播放：这一下之后才允许（如果又停了）显示播放按钮
      setUserPaused(false);
      setLoading(true);
      el.play().catch(() => undefined);
    } else {
      // 正在取流/缓冲就别停：这一下点的是「等」的画面，不是「播」的画面
      if (loading || el.seeking) return;
      setUserPaused(true); // 只有这里才是「用户暂停」
      el.pause();
    }
  };

  const onStageClick = () => {
    if (dragRef.current || scrubOn.current) return; // 拖进度条期间锁定画面点击
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 280) {
      lastTap.current = 0;
      // 双击点赞：和右侧那个心是同一个开关
      void toggleLike(video).then(() => bumpMarks());
      return;
    }
    lastTap.current = now;
    window.setTimeout(() => {
      if (lastTap.current === now) togglePlay();
    }, 280);
  };

  // 竖屏：上下滑 = 上一集 / 下一集（红果式）
  // 全屏：左右滑 = 调进度、上下滑 = 调音量、单击唤出/收起 UI、双击暂停
  const onTouchDown = (e: React.PointerEvent) => {
    if (dragRef.current || scrubOn.current) return; // 拖进度条期间不接管任何画面手势
    touchStart.current = { x: e.clientX, y: e.clientY, moved: false };
    if (fs) {
      const el = mediaEl();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      fsGest.current = {
        mode: 'idle',
        x: e.clientX,
        y: e.clientY,
        base: Number(el?.currentTime || 0),
        w: Math.max(1, r.width),
        h: Math.max(1, r.height),
        vol0: typeof el?.volume === 'number' ? el.volume : 1,
        moved: false,
        // 记下「按下之前」UI 是显还是隐：抬手后按它取反，不能被中间的重渲染带偏
        ui0: uiVisible,
      };
      hold.down();
      bumpUi();
      return;
    }
    swipeRef.current.on = true;
    swipeRef.current.dy = 0;
    hold.down(); // 按住不动 = 2 倍速，一移动就被取消
    bumpUi();
  };
  const onTouchMove = (e: React.PointerEvent) => {
    const t = touchStart.current;
    if (!t) return;
    const dy = e.clientY - t.y;
    const dx = e.clientX - t.x;
    hold.move(dx, dy);
    if (fs) {
      const g = fsGest.current;
      if (Math.abs(dy) > 10 || Math.abs(dx) > 10) g.moved = true;
      if (g.mode === 'idle') {
        if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx) * 1.25) {
          g.mode = 'vol';
          hold.cancel();
          setVolPct(g.vol0);
        } else if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.25) {
          g.mode = 'seek';
          scrubOn.current = true;
          setScrubbing(true);
          setFrame(null);
          fsSeekTo.current = g.base;
        }
      }
      if (g.mode === 'vol') {
        const el = mediaEl();
        if (!el) return;
        const next = Math.max(0, Math.min(1, g.vol0 - dy / Math.max(120, g.h * 0.55)));
        try {
          el.volume = next;
          if (next > 0 && el.muted) el.muted = false;
        } catch {
          /* noop */
        }
        setVolPct(next);
        return;
      }
      if (g.mode === 'seek') {
        const total2 = dur || Number(mediaEl()?.duration || 0);
        if (!total2) return;
        const span = Math.min(90, Math.max(20, total2 / 5));
        const next = Math.max(0, Math.min(total2, g.base + (dx / g.w) * span * 1.8));
        fsSeekTo.current = next;
        // 拖动时进度点实时跟手，真实画面等松手再跳
        setTime(next);
        return;
      }
      return;
    }
    if (Math.abs(dy) > 10 || Math.abs(dx) > 10) t.moved = true;
    if (Math.abs(dy) < Math.abs(dx) * 1.2) return;
    // 上下滑：舞台跟着手指走（原生画面同一帧对位），到边界加阻尼
    if (dy > 0 && cur <= 1) swipeRef.current.dy = dy * 0.3;
    else if (dy < 0 && cur >= total) swipeRef.current.dy = dy * 0.3;
    else swipeRef.current.dy = dy;
    setSwipeY(swipeRef.current.dy);
    if (nativeMode) engine.syncRect(true);
  };
  const onTouchUp = (e: React.PointerEvent) => {
    const t = touchStart.current;
    touchStart.current = null;
    if (fs) {
      const g = fsGest.current;
      const wasBoost = hold.up();
      if (wasBoost) {
        // 长按快放结束：抬手这一下不算点击
        if (g.mode === 'seek') scrubOn.current = false;
        setScrubbing(false);
        setVolPct(null);
        g.mode = 'idle';
        return;
      }
      if (g.mode === 'vol') {
        g.mode = 'idle';
        setVolPct(null);
        return;
      }
      if (g.mode === 'seek') {
        g.mode = 'idle';
        scrubOn.current = false;
        setScrubbing(false);
        const at = fsSeekTo.current;
        const el = mediaEl();
        try {
          if (el && at > 0) el.currentTime = at;
        } catch {
          /* noop */
        }
        setTime(at);
        // 松手后如果本来就是播着的，接着播；本来暂停的保持暂停
        if (!userPausedRef.current && el?.paused) {
          try {
            el.play()?.catch?.(() => undefined);
          } catch {
            /* noop */
          }
        }
        return;
      }
      g.mode = 'idle';
      if (!g.moved) {
        const now = Date.now();
        if (now - fsTapAt.current < 280) {
          window.clearTimeout(fsTapTimer.current);
          fsTapAt.current = 0;
          togglePlay();
          return;
        }
        fsTapAt.current = now;
        const wasVisible = g.ui0;
        window.clearTimeout(fsTapTimer.current);
        fsTapTimer.current = window.setTimeout(() => {
          fsTapAt.current = 0;
          // 按「按下之前」的状态取反：有 UI 就收起，没 UI 就唤出并重新计时
          if (wasVisible) {
            window.clearTimeout(fsHideT.current);
            setUiVisible(false);
          } else {
            bumpUi();
          }
        }, 280);
      }
      return;
    }
    const wasDragging = swipeRef.current.on && Math.abs(swipeRef.current.dy) > 6;
    swipeRef.current.on = false;
    // 长按快放结束：抬手这一下既不算暂停、也不算换集
    if (hold.up()) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 320);
      setSwipeY(0);
      return;
    }
    if (!t) return;
    if (!t.moved || !wasDragging) {
      if (wasDragging) setSwipeY(0);
      return;
    }
    const dy = e.clientY - t.y;
    const dx = e.clientX - t.x;
    const decide = Math.abs(dy) >= 70 && Math.abs(dy) > Math.abs(dx) * 1.4;
    if (!decide) {
      setSwipeY(0);
      if (nativeMode) window.setTimeout(() => engine.syncRect(true), 240);
      return;
    }
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 320);
    (window as any).__hgSwiped = performance.now();
    const next = dy < 0 ? cur + 1 : cur - 1;
    if (next < 1 || next > total) {
      setSwipeY(0);
      return;
    }
    // 整块滑出去，落定后再换集（换流期间封面垫着，不会黑）
    setSwipeY(dy < 0 ? -420 : 420);
    if (nativeMode) window.setTimeout(() => engine.syncRect(true), 120);
    window.setTimeout(() => {
      goEp(next);
      setSwipeY(0);
      setNready(false);
      if (nativeMode) window.setTimeout(() => engine.syncRect(true), 60);
    }, 200);
  };

  // 换集 / 换清晰度 / 退出时把那路预览解码器收掉，别攒着
  useEffect(() => {
    return () => {
      grabberRef.current?.dispose();
      grabberRef.current = null;
      lastGrab.current = 0;
    };
  }, [video.id, cur, quality]);

  // 拖进度条时把预览解码器建起来（第一次拖动才建，不拖不占资源）
  const seekAt = (track: HTMLElement, clientX: number, final = false, clientY = 0) => {
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    const r = track.getBoundingClientRect();
    const total = el?.duration || dur;
    if (!r.width || !total) return;
    // 整屏兜底旋转 90° 时轨道在屏幕上变成竖的：这时候必须按 Y 算，否则进度条不跟手还反着走
    const ratio = fsRot
      ? Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)))
      : Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const at = ratio * total;
    scrubAt.current = at;
    // 进度条立刻跟手——不等解码、不等 seek，手感才是顺的
    setTime(at);
    setScrubX(ratio);
    grabPreview(at, final);
    // 真正跳转放在松手那一下，拖动过程中只做预览，主画面不动
    if (final && el) {
      try {
        el.currentTime = at;
      } catch {
        /* noop */
      }
      setTime(at);
    }
  };

  /** 拖进度条时取一张「目标时间」的真帧（原生的走原生抓位图，网页的走独立解码实例） */
  const grabPreview = (at: number, final: boolean) => {
    const el: any = mode === 'borrow' ? liveRef.current : videoRef.current;
    if (!el) return;
    if (isNativeEl(el)) {
      // 原生 capture 内部是先 seek 再抓位图：节流一下否则解码器来不及
      const now = performance.now();
      if (!final && now - lastGrab.current < 160) return;
      lastGrab.current = now;
      el.capture(at);
      return;
    }
    if (!grabberRef.current) grabberRef.current = new FrameGrabber(video.id, cur, effQuality);
    const g = grabberRef.current;
    if (final) g.flush(at, (url, t) => setFrame({ url, time: t }));
    else g.push(at, (url, t) => setFrame({ url, time: t }));
  };

  const ranges: Array<[number, number]> = [];
  for (let s = 1; s <= total; s += RANGE) ranges.push([s, Math.min(total, s + RANGE - 1)]);
  const curRange = ranges[range] || [1, total];
  const eps: number[] = [];
  for (let n = curRange[0]; n <= curRange[1]; n++) eps.push(n);
  const pct = dur ? Math.min(100, (time / dur) * 100) : 0;
  const desc = (video.description || '暂无简介').replace(/\s+/g, ' ');

  // 竖屏播放页不自动隐藏：需要干净画面就点「清屏」按钮；
  // 全屏（横屏）那套才自动隐藏，而且给足 5 秒、拖进度条/开弹层期间不隐藏
  const bumpUi = () => {
    setUiVisible(true);
    if (!fs) return;
    window.clearTimeout(fsHideT.current);
    fsHideT.current = window.setTimeout(() => {
      if (scrubOn.current || dragRef.current || showEps || showQuality || showSpeed) return;
      setUiVisible(false);
    }, 8000);
  };

  const mediaEl = (): any => (mode === 'borrow' ? liveRef.current : videoRef.current);

  /**
   * 进度条的三个动作全页共用（竖屏 + 全屏都是这一套）。
   * 关键原则：拖的时候把别的操作全锁住，只允许动进度条；松手一律自动续播，
   * 只有用户自己按过暂停才保持暂停 —— 之前「拖几次就卡在暂停态、又显示转圈」就是这里判错了。
   */
  const scrubDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = true;
    scrubOn.current = true;
    setScrubbing(true);
    setFrame(null);
    const el = mediaEl();
    scrubWasPlaying.current = !!el && !el.paused;
    // 拖动期间来的 pause（seek 引起的那次）一律不算用户暂停
    scrubPauseRef.current = true;
    setPaused(false);
    try {
      el?.pause?.();
    } catch {
      /* noop */
    }
    seekAt(e.currentTarget as HTMLElement, e.clientX, false, e.clientY);
  };
  const scrubMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    seekAt(e.currentTarget as HTMLElement, e.clientX, false, e.clientY);
  };
  const scrubUp = () => {
    dragRef.current = false;
    scrubOn.current = false;
    const at = scrubAt.current;
    const el = mediaEl();
    try {
      if (el && at > 0) el.currentTime = at;
    } catch {
      /* noop */
    }
    grabPreview(at, true);
    setScrubbing(false);
    // 只有「用户自己按过暂停」才保持暂停；其余情况松手必续播
    if (userPausedRef.current) {
      scrubPauseRef.current = false;
      return;
    }
    setLoading(true);
    setPaused(false);
    setUserPaused(false);
    setScrubTail(true);
    window.clearTimeout(scrubTailT.current);
    scrubTailT.current = window.setTimeout(() => {
      setScrubTail(false);
      scrubPauseRef.current = false;
      const el2 = mediaEl();
      const stuck = el2 && el2.paused && !userPausedRef.current;
      const ready = typeof el2?.readyState !== 'number' || el2.readyState >= 2;
      if (stuck && ready) {
        try {
          el2.play()?.catch?.(() => undefined);
        } catch {
          /* noop */
        }
      }
    }, 900);
    try {
      el?.play?.()?.catch?.(() => undefined);
    } catch {
      /* noop */
    }
  };
  const scrubCancel = () => {
    dragRef.current = false;
    scrubOn.current = false;
    scrubPauseRef.current = false;
    setScrubbing(false);
  };

  /** 进全屏：就地把这一层铺满屏幕，同一个播放器接着播，不新开页面 */
  const enterFs = () => {
    setFs(true);
    setUiVisible(true);
    window.clearTimeout(fsHideT.current);
    fsHideT.current = window.setTimeout(() => setUiVisible(false), 8000);
    if (nativeMode) {
      // App 内：原生画面跟着真转屏，Activity 声明了 configChanges，转屏不会重建 WebView
      engine.orient(1);
      window.setTimeout(() => engine.syncRect(), 160);
      return;
    }
    try {
      document.documentElement.requestFullscreen?.().catch(() => undefined);
    } catch {
      /* noop */
    }
    const so: any = (screen as any).orientation;
    try {
      so?.lock?.('landscape')?.catch?.(() => undefined);
    } catch {
      /* 不支持锁屏就靠下面的兜底旋转 */
    }
    const check = () => setFsRotated(window.innerHeight > window.innerWidth + 40);
    window.setTimeout(check, 420);
  };

  /** 退全屏：回到竖屏布局，播放一点不动 */
  const exitFs = () => {
    setFs(false);
    setFsRotated(false);
    setUiVisible(true);
    window.clearTimeout(fsHideT.current);
    if (nativeMode) {
      engine.orient(2);
      window.setTimeout(() => engine.syncRect(), 200);
      return;
    }
    const so: any = (screen as any).orientation;
    try {
      so?.unlock?.();
    } catch {
      /* noop */
    }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
  };

  // 全屏时窗口尺寸变了（转屏/旋转兜底生效）：随时校正一次画面矩形
  useEffect(() => {
    if (!fs) return;
    const onResize = () => {
      if (!nativeMode) setFsRotated(window.innerHeight > window.innerWidth + 40);
      engine.syncRect();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [fs]);

  if (isDesktop) {
    return (
      <EpisodePlayerPC
        video={video}
        ep={cur}
        onClose={finish}
        onDetail={onDetail}
        onComment={onComment}
        onShare={onShare}
        onToast={onToast}
      />
    );
  }

  return (
    <div
      className={`eplayer${immersive ? ' immersive' : ''}${feed ? ' ghost' : ''}${
        mode === 'borrow' ? ' borrow' : ' own'
      }${wide === true ? ' wide' : ''}${uiVisible ? '' : ' hideui'}${scrubbing ? ' scrubbing' : ''}${
        fs ? ' fs' : ''
      }${fsRot ? ' rot' : ''}`}
    >
      {!immersive && !fs && (
        <header className="ehead">
          <button type="button" className="ehead-back" onClick={finish} aria-label="返回">
            <Icon name="back" size={24} strokeWidth={2.2} />
          </button>
          <button type="button" className="ehead-ep" onClick={() => setShowEps(true)}>
            第{cur}集
          </button>
          <span className="ehead-sp" />
          <button type="button" className="ehead-btn" onClick={() => setShowQuality(true)}>
            {QUALITY_LABEL[effQuality].split(' ')[0]}
          </button>
          <button type="button" className="ehead-btn" onClick={() => setShowSpeed(true)}>
            <Icon name="speed" size={20} strokeWidth={1.9} />
            倍速
          </button>
        </header>
      )}

      {/* 全屏（横屏）顶栏：返回 / 剧名 / 分享，和参考图一致 */}
      {fs && (
        <header className="lhead">
          <button type="button" className="licon" onClick={exitFs} aria-label="退出全屏">
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
      )}

      <div
        ref={stageRef}
        className="estage"
        style={{
          transform: `translateY(${swipeY}px)`,
          transition: swipeRef.current.on ? 'none' : 'transform 0.2s cubic-bezier(0.22,0.61,0.36,1)',
        }}
        onClick={() => {
          if (fs) return; // 全屏的点击由 pointer 手势统一仲裁（单击显隐 / 双击暂停）
          bumpUi();
          onStageClick();
        }}
        onPointerDown={onTouchDown}
        onPointerMove={onTouchMove}
        onPointerUp={onTouchUp}
        onPointerCancel={onTouchUp}
      >
        {mode === 'own' && (nativeMode ? (
          <>
            {/* 原生层在网页底下，换流期间它自己会藏起来——这层封面垫在后面，
                不管取流多慢都不会露出一块纯黑 */}
            <img
              className="evideo ecover"
              key={`${video.id}-${cur}`}
              src={coverUrl(video.cover)}
              alt=""
              style={{ opacity: nready ? 0 : 1 }}
            />
            <div ref={bindNative} className="evideo nstage" />
          </>
        ) : (
          <>
          <video
            ref={videoRef}
            className="evideo"
            playsInline
            preload="auto"
            muted={muted}
            poster={coverUrl(video.cover)}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              if (scrubOn.current) return; // 正在拖：进度条由手指决定
              setTime(el.currentTime);
              setDur(el.duration || 0);
              // 不再用「有时间就撤转圈」，那会在缓冲还没到位时把加载符号提前收掉
              saveTick(cur, el);
            }}
            onLoadedMetadata={(e) => {
              setDur(e.currentTarget.duration || 0);
              probeAspect(e.currentTarget);
            }}
            onPlay={() => {
              // 只同步状态，不撤转圈：play 只代表「不再是暂停态」，
              // 拖完进度条、刚换集时它照样是 0 码流，画面还顿着
              setPaused(false);
              setUserPaused(false);
            }}
            onPause={() => markPaused()}
            onWaiting={() => setLoading(true)}
            onPlaying={() => {
              setLoading(false);
            }}
            onCanPlay={(e) => {
              // 还没真的播起来就别把转圈撤了，否则就剩一个播放三角挂在那儿
              if (e.currentTarget.paused) return;
              setLoading(false);
            }}
            onEnded={() => {
              if (cur < total) goEp(cur + 1);
              else {
                setPaused(true);
                setUserPaused(true);
              }
            }}
          />
          {/* 网页内核换 src 会留上一帧，垫一层封面，等新流出画再淡出 */}
          <img
            className="evideo ecover"
            key={`${video.id}-${cur}`}
            src={coverUrl(video.cover)}
            alt=""
            style={{ opacity: nready ? 0 : 1 }}
          />
          </>
        ))}
        {/*
          中央只有两种合法状态：
          1) 用户自己按了暂停（userPaused）→ 播放三角，点一下继续；
          2) 没在播但其实是在等（加载中 / 被上游或切集打断）→ 转圈，点一下也重新起播。
          正在播就什么都不显示。绝不用播放器自己的 paused 判断，那个会被拖动/切入顺手改。
        */}
        {(userPaused || loading || paused) && (
          <button
            type="button"
            className="ebigplay"
            aria-label={userPaused ? '播放' : '加载中'}
            onClick={togglePlay}
          >
            {userPaused ? (
              <Icon name="play" size={32} strokeWidth={2} />
            ) : (
              <span className="hg-spin" />
            )}
          </button>
        )}
        {tip && <div className="etip">{tip}</div>}
        {volPct !== null && <div className="ltip">音量 {Math.round(volPct * 100)}%</div>}
        {boostOn && <div className="eboost">2 倍速播放中</div>}
        {flashEp && <div className="eflash">{flashEp}</div>}
        {swipeY !== 0 && (
          <div className="eswipehint" style={{ opacity: Math.min(1, Math.abs(swipeY) / 110) }}>
            {swipeY < 0
              ? cur < total
                ? `松开播放 第${cur + 1}集`
                : '已是最后一集'
              : cur > 1
                ? `松开回到 第${cur - 1}集`
                : '已是第一集'}
          </div>
        )}
      </div>

      {!immersive && !fs && (
        <>
          {/* 横屏剧：全屏观看按钮跟着画面底边走，像首页那样落在视频正下方 */}
          {wide === true && (
            <button
              type="button"
              className="efs-float"
              style={{ ['--ar' as any]: String(ar || 1.78) }}
              onClick={enterFs}
            >
              <Icon name="expand" size={18} strokeWidth={2} />
              全屏观看
            </button>
          )}
          <div className="erail">
            <button
              type="button"
              className={`erail-item${isFav(video.id) ? ' on' : ''}`}
              onClick={() => {
                void toggleFav(video).then(() => bumpMarks());
              }}
            >
              <Icon name={isFav(video.id) ? 'starFill' : 'star'} size={28} strokeWidth={1.5} />
              <span>{fmtNum((video.collect_count || 0) + (isFav(video.id) ? 1 : 0))}</span>
            </button>
            <button type="button" className="erail-item" onClick={() => onComment(video)}>
              <Icon name="chat" size={28} strokeWidth={1.7} />
              <span>{fmtNum(cmtN)}</span>
            </button>
            <button
              type="button"
              className={`erail-item${isLiked(video.id) ? ' on' : ''}`}
              onClick={() => {
                void toggleLike(video).then(() => bumpMarks());
              }}
            >
              <Icon name={isLiked(video.id) ? 'heartFill' : 'heart'} size={28} strokeWidth={1.7} />
              <span>{fmtNum((video.like_count || 0))}</span>
            </button>
            <button type="button" className="erail-item" onClick={() => onShare(video, cur)}>
              <Icon name="share" size={28} strokeWidth={1.8} />
              <span>分享</span>
            </button>
          </div>

          <div className="einfo">
            <div className="einfo-title" onClick={() => onDetail(video.id)}>
              <span className="ebadge">爆剧</span>
              <b>{video.title}</b>
              <Icon name="chevron" size={15} strokeWidth={2.2} />
              <span className="einfo-sp" />
            </div>
            <div
              className={`einfo-desc${expanded ? ' open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              第{cur}集 ｜ {desc}
              <span className="emore">{expanded ? ' 收起' : ' 展开'}</span>
            </div>
            <div className="eauthorship">
              <Icon name="info" size={13} strokeWidth={1.9} />
              作者声明：内容由AI生成
            </div>
          </div>

          <div className="efoot">
            <div
              className={`eprog${scrubbing ? ' on' : ''}`}
              ref={trackRef}
              onPointerDown={scrubDown}
              onPointerMove={scrubMove}
              onPointerUp={scrubUp}
              onPointerCancel={scrubCancel}
            >
              {scrubbing && dur > 0 && (
                <ScrubTip className="eprev" url={frame?.url} time={time} dur={dur} x={scrubX} />
              )}
              <i style={{ width: `${pct}%` }} />
              <span className="eprog-time">
                {fmtDuration(time)} / {fmtDuration(dur)}
              </span>
            </div>
            <div className="efoot-row">
              <button type="button" className="epill" onClick={() => setShowEps(true)}>
                选集 · {video.is_finished ? '已完结' : '连载中'} · 全{total}集
                <Icon name="chevron" size={14} style={{ transform: 'rotate(-90deg)' }} />
              </button>
              <button
                type="button"
                className="eclean"
                onClick={() => setImmersive(true)}
                aria-label="清屏播放"
              >
                <Icon name="expand" size={20} strokeWidth={1.9} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* 全屏（横屏）底栏：进度条 + 左下播放/时间/点赞评论收藏 + 右下倍速/清晰度/选集 */}
      {fs && (
        <div className="lbar">
          <div
            className={`lprog${scrubbing ? ' on' : ''}`}
            ref={trackRef}
            onPointerDown={scrubDown}
            onPointerMove={scrubMove}
            onPointerUp={scrubUp}
            onPointerCancel={scrubCancel}
          >
            {scrubbing && dur > 0 && (
              <ScrubTip className="lprev" url={frame?.url} time={time} dur={dur} x={scrubX} />
            )}
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="lrow">
            {cur < total && (
              <button
                type="button"
                className="lact lnext"
                onClick={() => goEp(Math.min(total, cur + 1))}
              >
                <Icon name="chevron" size={18} strokeWidth={2} />
                下一集
              </button>
            )}
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
              {fmtNum(video.like_count || 0)}
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
            <span className="lfunc">
              <button
                type="button"
                className="lact"
                onClick={() => {
                  const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                  setSpeed(next);
                  const el = mediaEl();
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
      )}

      {immersive && (
        <button type="button" className="eexit" onClick={() => setImmersive(false)}>
          退出清屏
        </button>
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
                    goEp(n);
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

      {showQuality && (
        <>
          <div className="sheet-mask" onClick={() => setShowQuality(false)} />
          <div className="speedsheet">
            <div className="eps-head">
              <span>清晰度</span>
              <span className="eps-sub">
                {hasHevc ? '720P / 1080P' : '本集无 1080P 流'}
              </span>
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
                    // 换清晰度必须有反馈，否则不知道是真换了还是 UI 敷衍
                    onToast(`已切换到 ${QUALITY_LABEL[q]}`);
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

      {showSpeed && (
        <>
          <div className="sheet-mask" onClick={() => setShowSpeed(false)} />
          <div className="speedsheet">
            <div className="eps-head">
              <span>播放倍速</span>
            </div>
            <div className="speed-list">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={Math.abs(s - speed) < 0.01 ? 'on' : ''}
                  onClick={() => {
                    setSpeed(s);
                    const el = mode === 'borrow' ? liveRef.current : videoRef.current;
                    if (el) el.playbackRate = s;
                    setShowSpeed(false);
                  }}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
