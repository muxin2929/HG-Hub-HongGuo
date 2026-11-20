/**
 * 原生播放内核（Android App 内）。
 *
 * 老壳子把整页塞进 WebView，视频也走 hls.js（MSE）——Android WebView 的 MSE 不支持
 * HEVC，所以上游那条 `hevc`(1080P fMP4) 流在手机上根本用不上。
 *
 * 现在把「解码 + 渲染」交给原生 ExoPlayer（TextureView），WebView 只画浮层 UI：
 *   - 原生视频层在 WebView 下面，网页里把视频区域做成透明，就透出原生画面；
 *   - JS 侧只保留一个 Engine（全局唯一的原生 Player），各页面用 NativeEl 这个
 *     「长得像 <video>」的壳去驱动它，原有播放逻辑（进度条、选集、滑动换集）不用重写；
 *   - 同一个 player 跨页面复用：首页 → 播放页是同一个实例在播，天然无缝。
 *
 * 没有原生桥（普通浏览器 / 桌面端）时，这个模块完全不生效，仍然走原来的 hls.js。
 */

export type Fit = 'contain' | 'cover' | 'fill';

/**
 * 会话内的「当前占用原生播放器的到底是谁」。
 * 记的是 (剧, 集, 流地址) 三者一起，只认完全吻合的那一次：
 * 换个入口点进同一部同一集，就沿用它，不重新取流、不回到 0；
 * 换了剧或换了集，三项对不上，一律重新 open —— 绝不会串成首页那条视频。
 */
interface LivePlay {
  vid: string;
  ep: number;
  uri: string;
  t: number;
  dur: number;
}

let livePlay: LivePlay | null = null;

/** 取流成功时登记：这条流属于哪部哪集 */
export function markPlay(vid: number | string, ep: number, uri: string) {
  if (!uri) return;
  const same = livePlay && livePlay.vid === String(vid) && livePlay.ep === ep && livePlay.uri === uri;
  livePlay = {
    vid: String(vid),
    ep,
    uri,
    t: same ? livePlay!.t : 0,
    dur: same ? livePlay!.dur : 0,
  };
}

/** 当前原生播放器里装的是哪部哪集（没有就是 null） */
export function livePlayback(): LivePlay | null {
  return livePlay;
}

// ---------------------------------------------------------------- 设备排障上报
// 只在 App 内启用：把原生层推上来的 dbg（播放器状态/画幅/矩形/可见性/纹理亮度）
// 和开机时的透明层自检发到网关 /api/log，服务端 logs/app.log 里能直接看。
const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || '').replace(/\/$/, '');
const LOG_URL = API_BASE ? `${API_BASE}/api/log` : '';
let logBudget = 90;

export function report(tag: string, data: any) {
  try {
    if (!nativeMode || logBudget <= 0 || !LOG_URL) return;
    logBudget -= 1;
    const body = JSON.stringify({
      tag,
      cls: document.documentElement.className,
      iw: window.innerWidth,
      ih: window.innerHeight,
      d: data,
    });
    fetch(LOG_URL, { method: 'POST', body, keepalive: true }).catch(() => undefined);
  } catch {
    /* noop */
  }
}

/** 开机自检：html/body/各层底色 + 是否拿到桥 —— 黑屏时看一眼就知道是谁盖住了 */
export function reportBoot() {
  if (!nativeMode) return;
  const chain: any[] = [];
  let el: HTMLElement | null = document.querySelector('.slide.active .slide-stage') as HTMLElement;
  while (el && el !== document.documentElement && chain.length < 14) {
    const cs = getComputedStyle(el);
    chain.push((el.className || '').toString().slice(0, 28) + ':' + cs.backgroundColor);
    el = el.parentElement;
  }
  const bridge = !!(window as any).HGVideo;
  const caps = (() => {
    try {
      return (window as any).HGVideo?.caps?.() || '';
    } catch {
      return 'err';
    }
  })();
  report('boot', {
    bridge,
    caps,
    chain,
    htmlbg: getComputedStyle(document.documentElement).backgroundColor,
    bodybg: getComputedStyle(document.body).backgroundColor,
  });
}

export interface NativeCaps {
  hevc: boolean;
  hevc1080: boolean;
  sdk: number;
  model: string;
}

interface RawBridge {
  caps(): string;
  open(uri: string, start: number, rate: number, muted: number): void;
  play(): void;
  pause(): void;
  seek(t: number): void;
  speed(r: number): void;
  mute(m: number): void;
  stop(): void;
  rect(x: number, y: number, w: number, h: number, fit: number): void;
  visible(v: number): void;
  awake(v: number): void;
  /** 抓一帧（拖进度条预览）：结果走 __hgNative 的 'frame' 事件 */
  grab(t: number): void;
}

const LS_OFF = 'hg.native.off';
const raw = (): RawBridge | undefined => (window as any).HGVideo;
/** 浏览器里预览原生版式（?hg-native-preview=1），用真 <video> 冒充原生层 */
const PREVIEW = /(?:^|[?&])hg-native-preview=1/.test(location.search);

function disabledByUser(): boolean {
  try {
    return localStorage.getItem(LS_OFF) === '1';
  } catch {
    return false;
  }
}

export const nativeMode: boolean = (!!raw() || PREVIEW) && !disabledByUser();

// ---------------------------------------------------------------- 原生底部导航
/**
 * App 里底部导航改成本地控件（54dp、图标 23dp、文字 11sp，和网页 .tabbar 同尺寸），
 * 这样切 tab、选中态、深色底都走原生绘制，不再依赖 WebView 的合成。
 * 网页这边只负责三件事：上报当前选中项/深浅、上报该不该显示、把原生点击转给 React。
 */
interface ShellBridge {
  tab(key: string, dark: number): void;
  tabs(visible: number): void;
}

const shellBridge = (): ShellBridge | undefined => (window as any).HGShell;

/** 有原生 tabbar 时，网页自己的那条就不要画了（否则会叠两条） */
export const shellTabBar: boolean = !!shellBridge();

export function shellActive(key: string, dark: boolean): void {
  try {
    shellBridge()?.tab(key, dark ? 1 : 0);
  } catch {
    /* noop */
  }
}

export function shellVisible(visible: boolean): void {
  try {
    shellBridge()?.tabs(visible ? 1 : 0);
  } catch {
    /* noop */
  }
}

/** 原生层连续报错时，退回 hls.js 并记住这台设备，别让用户一直看黑屏 */
export function disableNative(): void {
  try {
    localStorage.setItem(LS_OFF, '1');
  } catch {
    /* noop */
  }
  location.reload();
}

let capsCache: NativeCaps | null = null;
export function nativeCaps(): NativeCaps {
  if (capsCache) return capsCache;
  let parsed: any = null;
  try {
    parsed = raw() ? JSON.parse(raw()!.caps()) : null;
  } catch {
    parsed = null;
  }
  capsCache = {
    hevc: !!parsed?.hevc,
    hevc1080: !!parsed?.hevc1080,
    sdk: Number(parsed?.sdk || 0),
    model: String(parsed?.model || ''),
  };
  return capsCache;
}

// ---------------------------------------------------------------- 事件

export interface EngineState {
  time: number;
  dur: number;
  playing: boolean;
  buffering: boolean;
  vw: number;
  vh: number;
  ended: boolean;
}

/**
 * 全局唯一原生播放器。页面里所有 NativeEl 都是它的皮。
 *
 * 注意：feed 有多个实例（三个频道各一个，全部常驻），所以「注册表」按元素实例记，
 * 「谁在占画面」只认最后 claim 的那个元素，换频道/进出播放页都不会抢错人。
 */
class Engine {
  state: EngineState = { time: 0, dur: 0, playing: false, buffering: false, vw: 0, vh: 0, ended: false };
  uri = '';
  owner = '';
  errorCount = 0;
  /** 当前占画面的那个壳 */
  active: NativeEl | null = null;

  /** 首页那一屏正在播的流：播放页关掉后要把它接回来（记 vid/ep，换过集也能对上） */
  private anchor: { el: NativeEl; uri: string; vid: string; ep: number; time: number } | null = null;
  private lastRect = '';
  /** 最近一次原生层有进展的时刻（诊断用） */
  lastProgAt = 0;
  /** 最近一次交给原生的流（诊断用） */
  lastUri = '';
  /** 最近一次原生层抓上来的帧（拖进度条预览用） */
  frame = { url: '', t: 0 };

  /** 某个壳接管画面：换流只在 uri 变化时发生 */
  claim(el: NativeEl, uri: string, fit: Fit, start?: number) {
    this.active = el;
    this.owner = el.slot;
    el.fit = fit;
    if (el.slot === 'feed') {
      this.anchor = {
        el,
        uri,
        vid: (livePlay && livePlay.vid) || '',
        ep: (livePlay && livePlay.ep) || 1,
        time: this.state.time || 0,
      };
    }
    const b = raw();
    if (!b) {
      if (PREVIEW) previewBridge.open(uri, start || 0, this.rate, this.muted);
      this.syncRect(true);
      return;
    }
    if (uri && uri !== this.uri) {
      // 换片子：先让原生层收起来（open 里会把整块藏到新流第一帧为止），
      // 再对位。顺序反了就会把上一条流的画面搬到新矩形上闪一下。
      this.setVisible(false);
      b.open(uri, start || 0, this.rate, this.muted ? 1 : 0);
      this.uri = uri;
      this.lastUri = uri.split('/').pop() || uri;
      // 上一条流的尺寸/时长不能留着，否则新画幅会先用旧比例量一遍
      this.state.vw = 0;
      this.state.vh = 0;
      this.state.time = 0;
      this.state.dur = 0;
      this.state.ended = false;
      this.syncRect(true);
      this.setVisible(true);
      this.lastRect = '';
      return;
    }
    this.syncRect(true);
    if (uri && start && start > 2 && Math.abs(start - this.state.time) > 2) {
      b.seek(start);
    }
  }

  /** 播放页这种「临时占地」的壳释放画面，把首页那条流接回原位 */
  release(slot: string) {
    if (this.owner !== slot) return;
    const a = this.anchor;
    this.owner = '';
    this.active = null;
    if (!a || a.el.slot === slot) return;
    const lp = livePlay;
    if (lp && a.vid && lp.vid === a.vid) {
      // 同一部剧：交给首页的是「刚才实际播到哪」—— uri 用当前这条流、时间用 state.time，
      // 而不是进门那一刻的快照。这样播放页里换了集 / 看了十分钟，回来都是原位置，
      // 同一条流也不会重新 open（就是那次又卡又没转圈）。
      this.claim(a.el, this.uri, 'contain', this.state.time || 0);
      return;
    }
    // 播放页放的是别的片子：首页还原它自己原来那条流和原来的位置
    this.claim(a.el, a.uri, 'contain', a.time || 0);
  }

  /** 横屏等外部因素停掉原生层之后，把首页那条流重新挂回来 */
  reclaim() {
    if (!this.anchor) return;
    const a = this.anchor;
    this.claim(a.el, a.uri, 'contain', a.time);
  }

  play() {
    raw()?.play();
    if (PREVIEW) previewBridge.play();
  }

  pause() {
    raw()?.pause();
    if (PREVIEW) previewBridge.pause();
  }

  seek(t: number) {
    raw()?.seek(t);
    if (PREVIEW) previewBridge.seek(t);
  }

  stop() {
    raw()?.stop();
    if (PREVIEW) previewBridge.stop();
    this.uri = '';
    this.owner = '';
    this.active = null;
  }

  rate = 1;
  muted = true;
  /** 切 tab 滑动期间扣住原生层，谁调 setVisible(true) 都不放行 */
  visHeld = false;

  setRate(r: number) {
    this.rate = r;
    raw()?.speed(r);
    if (PREVIEW) previewBridge.speed(r);
  }

  setMuted(m: boolean) {
    this.muted = m;
    raw()?.mute(m ? 1 : 0);
    if (PREVIEW) previewBridge.mute(m);
  }

  awake(on: boolean) {
    raw()?.awake(on ? 1 : 0);
  }

  /** 画面区域跟着占位元素走（首页是舞台框，播放页是视频框），像素按 CSS px 给 */
  syncRect(force = false) {
    const el = this.active;
    if (!el?.host) return;
    const r = el.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const payload = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}:${el.fit}`;
    if (!force && payload === this.lastRect) return;
    this.lastRect = payload;
    raw()?.rect(
      Math.round(r.left * dpr),
      Math.round(r.top * dpr),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr),
      el.fit === 'cover' ? 1 : el.fit === 'contain' ? 0 : 2,
    );
    if (PREVIEW) previewBridge.rect(r.left, r.top, r.width, r.height, el.fit);
  }

  /**
   * 切 tab 时四个 pane 在滑动，原生画面不跟着滑：
   * 先把「显示」请求扣住（hide=true 立刻藏起来），等轨道滑完再放行。
   * 滑动期间不管页面里谁调 play()/setVisible(true)，都不会把偏位的画面翻出来。
   */
  holdVisible() {
    this.visHeld = true;
    this.setVisible(false);
  }

  releaseVisible(show: boolean) {
    this.visHeld = false;
    if (show) {
      raw()?.visible(1);
      if (PREVIEW) previewBridge.setVisible(true);
    }
  }

  setVisible(v: boolean) {
    // 被 hold 住时只允许「藏」，不允许「显」
    if (v && this.visHeld) return;
    raw()?.visible(v ? 1 : 0);
    if (PREVIEW) previewBridge.setVisible(v);
  }

  /** 让原生壳真转屏：1 横屏（全屏页用），2 竖屏，0 交回传感器 */
  orient(mode: 0 | 1 | 2) {
    try {
      (raw() as any)?.orient?.(mode);
    } catch {
      /* 旧版 APK 没有这个桥方法：退回 Web 侧旋转兜底 */
    }
  }

  /** 原生层推上来的状态 */
  push(ev: string, data: any) {
    const st = this.state;
    if (ev === 'time') {
      st.time = Number(data.t || 0);
      st.dur = Number(data.d || 0);
      st.playing = !!data.p;
      st.buffering = !!data.b;
      if (this.anchor && this.owner === this.anchor.el.slot) this.anchor.time = st.time;
      // 顺手把「这条流播到哪了」记进会话表，换入口回来就能原地接上
      if (livePlay && livePlay.uri === this.uri) {
        livePlay.t = st.time;
        livePlay.dur = st.dur;
      }
      this.lastProgAt = Date.now();
    } else if (ev === 'ready') {
      st.dur = Number(data.d || st.dur);
      this.errorCount = 0;
      this.lastProgAt = Date.now();
    } else if (ev === 'size') {
      st.vw = Number(data.w || 0);
      st.vh = Number(data.h || 0);
      this.lastProgAt = Date.now();
    } else if (ev === 'ended') {
      st.ended = true;
      st.playing = false;
    } else if (ev === 'state') {
      st.playing = !!data.p;
      st.buffering = !!data.b;
      if (data.e) st.ended = true;
    } else if (ev === 'dbg') {
      report('dbg', data);
      return;
    } else if (ev === 'frame') {
      this.frame = { url: String(data.d || ''), t: Number(data.t || 0) };
    } else if (ev === 'error') {
      report('error', data);
      this.errorCount += 1;
      if (nativeMode && this.errorCount >= 3) disableNative();
    }
    const owner = this.active;
    if (owner) owner.emitFromEngine(ev, data);
  }
}

export const engine = new Engine();

// ---------------------------------------------------------------- <video> 的替身

/**
 * 长得像 HTMLVideoElement 的壳：组件里 el.currentTime / el.play() / addEventListener
 * 全部照旧可用，只是实际操作的是原生 player。
 */
export class NativeEl {
  readonly isNativeEl = true;
  /** 逻辑槽位：feed（首页那一屏）/ player（播放页） */
  readonly slot: string;
  fit: Fit;
  host: HTMLElement | null = null;
  uri = '';
  videoWidth = 0;
  videoHeight = 0;
  readyState = 0;
  seekable = { length: 1, start: () => 0, end: () => this.duration };

  private ls = new Map<string, Set<(e?: any) => void>>();
  private _muted = true;
  private _rate = 1;

  constructor(slot: string, fit: Fit) {
    this.slot = slot;
    this.fit = fit;
  }

  /** 我是不是当前占画面的那个 */
  private get mine() {
    return engine.active === this;
  }

  get currentTime() {
    return this.mine ? engine.state.time : 0;
  }
  set currentTime(v: number) {
    if (!this.mine) this.claim();
    engine.seek(Math.max(0, v));
  }

  get duration() {
    return this.mine ? engine.state.dur : 0;
  }
  get paused() {
    return !(this.mine && engine.state.playing);
  }
  get ended() {
    return this.mine && engine.state.ended;
  }
  /** 真实缓冲中（ExoPlayer STATE_BUFFERING）：中央转圈只认这个，别拿 paused 顶替 */
  get buffering() {
    return this.mine ? engine.state.buffering : false;
  }
  get muted() {
    return this._muted;
  }
  set muted(v: boolean) {
    this._muted = v;
    engine.setMuted(v);
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(v: number) {
    this._rate = v;
    engine.setRate(v);
  }

  /** attachStream 里调用：记住这条流并接管画面 */
  attach(uri: string, fit?: Fit, start?: number) {
    this.uri = uri;
    this.claim(fit, start);
  }

  claim(fit?: Fit, start?: number) {
    engine.setMuted(this._muted);
    engine.setRate(this._rate);
    engine.claim(this, this.uri, fit || this.fit, start);
  }

  play(): Promise<void> {
    if (this.uri && engine.uri !== this.uri) {
      this.claim();
    } else if (!this.mine) {
      this.claim();
    }
    engine.setMuted(this._muted);
    engine.setRate(this._rate);
    engine.awake(true);
    engine.setVisible(true);
    engine.play();
    this.emit('play');
    return Promise.resolve();
  }

  pause() {
    if (!this.mine) return;
    engine.pause();
    this.emit('pause');
  }

  load() {
    /* 原生层自己管理流 */
  }

  /** 让原生层抓一帧画面（拖进度条时的预览缩略图），结果通过 'frame' 事件回来 */
  capture(t: number) {
    if (!this.mine) return;
    try {
      raw()?.grab(t);
    } catch {
      /* 旧版 APK 没有这个桥方法：忽略即可 */
    }
  }

  /** 最近一次抓到的帧（data:image/jpeg;base64,...） */
  get frameUrl() {
    return engine.frame.url;
  }
  get frameTime() {
    return engine.frame.t;
  }

  removeAttribute() {
    /* noop */
  }

  addEventListener(type: string, cb: (e?: any) => void, opts?: { once?: boolean } | boolean) {
    const once = typeof opts === 'object' && !!opts?.once;
    const set = this.ls.get(type) || new Set();
    const wrapped = (e?: any) => {
      if (once) set.delete(wrapped);
      cb(e);
    };
    set.add(wrapped);
    this.ls.set(type, set);
  }

  /** 简化版订阅：返回取消函数，组件里用这个 */
  on(type: string, cb: (e?: any) => void): () => void {
    const set = this.ls.get(type) || new Set();
    set.add(cb);
    this.ls.set(type, set);
    return () => {
      set.delete(cb);
    };
  }

  removeEventListener(type: string, cb: (e?: any) => void) {
    this.ls.get(type)?.delete(cb);
  }

  emit(type: string) {
    this.ls.get(type)?.forEach((cb) => {
      try {
        cb({ type, currentTarget: this, target: this });
      } catch {
        /* noop */
      }
    });
  }

  emitFromEngine(ev: string, data: any) {
    const st = engine.state;
    this.videoWidth = st.vw || this.videoWidth;
    this.videoHeight = st.vh || this.videoHeight;
    this.readyState = st.dur || st.vw ? 1 : 0;
    switch (ev) {
      case 'time':
        // 原生层只回推 time/state 两种，网页里的 onWaiting / onPlaying 全靠这里转译：
        // 拖动松手后 ExoPlayer 重新缓冲的这段时间必须让前端看见「转圈」，否则就是干等黑屏
        if (data?.b) this.emit('waiting');
        else if (data?.p) this.emit('playing');
        this.emit('timeupdate');
        this.emit('durationchange');
        break;
      case 'ready':
        this.emit('loadedmetadata');
        this.emit('durationchange');
        this.emit('canplay');
        break;
      case 'size':
        this.emit('loadedmetadata');
        this.emit('resize');
        break;
      case 'ended':
        this.emit('ended');
        break;
      case 'state':
        if (data?.b) this.emit('waiting');
        this.emit(data?.p ? 'play' : 'pause');
        // 还在缓冲就别报 playing：p=true 只代表「不是暂停」，不代表有画面，
        // 报了会把转圈提前撤掉，剩个顿住的画面
        if (data?.p && !data?.b) this.emit('playing');
        break;
      case 'error':
        this.emit('error');
        break;
      case 'frame':
        this.emit('frame');
        break;
      case 'ff':
        // 原生层真的渲出第一帧了：这时候才能撤封面垫层，否则中间会闪一帧黑
        this.emit('firstframe');
        this.emit('loadeddata');
        break;
      default:
        break;
    }
  }

  destroy() {
    if (engine.active === this) {
      engine.active = null;
    }
  }
}

export function isNativeEl(el: any): el is NativeEl {
  return !!el && el.isNativeEl === true;
}

// ---------------------------------------------------------------- 浏览器预览通道

/**
 * 用真 <video> 冒充原生层：验证「网页透明 + 底层画面 + 矩形对齐」这一套版式，
 * 只在 ?hg-native-preview=1 时启用，不影响线上。
 */
class PreviewBridge {
  private box: HTMLDivElement | null = null;
  private el: HTMLVideoElement | null = null;
  private hls: any = null;
  private fit: Fit = 'contain';
  private timer = 0;

  private ensure() {
    if (this.box) return;
    const box = document.createElement('div');
    box.id = 'hg-preview-layer';
    box.style.cssText =
      'position:fixed;z-index:-1;left:0;top:0;width:100%;height:100%;pointer-events:none;background:#000;display:none';
    const v = document.createElement('video');
    v.muted = true;
    v.setAttribute('playsinline', '1');
    v.style.cssText = 'position:absolute;object-fit:fill;background:#000';
    box.appendChild(v);
    document.body.appendChild(box);
    this.box = box;
    this.el = v;
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  private tick() {
    const v = this.el;
    if (!v || !v.duration) return;
    engine.push('time', { t: v.currentTime, d: v.duration, p: !v.paused, b: v.readyState < 3 });
  }

  rect(x: number, y: number, w: number, h: number, fit: Fit) {
    this.ensure();
    if (!this.box) return;
    this.box.style.display = 'block';
    this.box.style.left = `${x}px`;
    this.box.style.top = `${y}px`;
    this.box.style.width = `${w}px`;
    this.box.style.height = `${h}px`;
    this.fit = fit;
  }

  setVisible(v: boolean) {
    this.ensure();
    if (this.box) this.box.style.display = v ? 'block' : 'none';
  }

  async open(uri: string, start = 0, _rate = 1, muted = true) {
    this.ensure();
    const v = this.el!;
    v.muted = muted;
    if (!uri) return;
    this.hls?.destroy();
    this.hls = null;
    const { default: Hls } = await import('hls.js');
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 20 });
      h.loadSource(uri);
      h.attachMedia(v);
      this.hls = h;
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        if (start > 1) v.currentTime = start;
        v.play().catch(() => undefined);
      });
      h.on(Hls.Events.ERROR, (_e: any, d: any) => {
        if (d?.fatal) engine.push('error', { msg: String(d.details) });
      });
    } else {
      v.src = uri;
      await v.play().catch(() => undefined);
    }
  }

  play() {
    this.el?.play().catch(() => undefined);
    engine.push('state', { p: true });
  }
  pause() {
    this.el?.pause();
    engine.push('state', { p: false });
  }
  seek(t: number) {
    if (this.el) this.el.currentTime = t;
  }
  speed(r: number) {
    if (this.el) this.el.playbackRate = r;
  }
  mute(m: boolean) {
    if (this.el) this.el.muted = m;
  }
  stop() {
    this.hls?.destroy();
    this.hls = null;
    this.el?.pause();
  }
}

const previewBridge = new PreviewBridge();

// 原生层回调入口（Java 侧 evaluateJavascript 调它）
if (nativeMode) {
  (window as any).__hgNative = (json: string) => {
    try {
      const d = typeof json === 'string' ? JSON.parse(json) : json;
      engine.push(String(d.ev || d.e), d);
    } catch {
      /* noop */
    }
  };
  // 矩形同步：转屏 / 键盘 / 页面切换后重新对位。
  // 320ms 一次：换页/换集的版式变化能马上跟上，代价只有一次桥调用。
  const sync = () => engine.syncRect();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => window.setTimeout(sync, 260));
  document.addEventListener('visibilitychange', sync);
  window.setInterval(() => engine.syncRect(), 320);
}
