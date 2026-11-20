import type { Streams } from '../data/types';
import { api } from '../data/api';
import { engine, isNativeEl, livePlayback, markPlay, nativeCaps, nativeMode } from './native';

/**
 * 播放内核：解析 + 缓存 + 预加载。
 *
 * 关键点：
 *  - /api/play 一次解析拿到 main/hevc/preview 三个清单地址，网关已经改写成
 *    /media/manifest?u=... 的同源地址，hls.js 只跟本站说话；
 *  - 同一集只解析一次（Map 缓存 + in-flight promise 去重），滑回上一集不重复请求；
 *  - 预加载只解析地址、不建 Hls 实例，省内存。
 */

export type QualityKey = 'main' | 'hevc' | 'preview';

// ---------------------------------------------------------------- 播放器接管（同一个 instance 跨页面复用）
// 记录每个 <video> 上挂着的播放实例，页面切换时把它搬到新容器里，不重建、不重新缓冲
const mounted = new WeakMap<HTMLVideoElement, AttachedPlayer & { key: string }>();

/**
 * 组件切页时先 destroy、再在回来时 attach，是固定套路。
 * 如果 destroy 立刻把 hls 干掉，同一集回来就只能重新加载（进度也丢）。
 * 所以销毁延后 1.5 秒：这期间又 attach 同一集就撤销销毁，直接续上。
 */
const disposeTimers = new WeakMap<HTMLVideoElement, number>();

function deferDispose(video: HTMLVideoElement, fn: () => void) {
  const old = disposeTimers.get(video);
  if (old) window.clearTimeout(old);
  const t = window.setTimeout(() => {
    disposeTimers.delete(video);
    fn();
  }, 1500);
  disposeTimers.set(video, t);
}

function cancelDispose(video: HTMLVideoElement) {
  const t = disposeTimers.get(video);
  if (t) {
    window.clearTimeout(t);
    disposeTimers.delete(video);
  }
}

export function takePlayer(video: HTMLVideoElement) {
  return mounted.get(video) || null;
}

/** 找到首页里正在播放的那个 video（feed 会打上 data-hg-feed 标记） */
export function findLiveFeedVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('.cfwrap.on .slide.active video[data-hg-feed]') ||
    document.querySelector<HTMLVideoElement>('.home-wrap .slide.active video[data-hg-feed]')
  );
}

/** 暂停页面上所有 feed 视频（播放页自己播时，别让首页在下面偷偷放） */
export function pauseFeedVideos(except?: HTMLVideoElement | null): void {
  document.querySelectorAll<HTMLVideoElement>('.feed video').forEach((x) => {
    if (x !== except) {
      try {
        x.pause();
      } catch {
        /* noop */
      }
    }
  });
}

// App 内页面跑在虚拟域名上，所有站内相对地址必须补全成线上域名，否则会被本地拦截器当成静态资源
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const abs = (u: string) => (u && u.startsWith('/') ? BASE + u : u);

const HEVC_BROKEN_KEY = 'hg.hevc.broken';

/** 某台设备曾经解不了 HEVC，就不再给它推荐 1080P */
export function markHevcBroken(): void {
  try {
    localStorage.setItem(HEVC_BROKEN_KEY, '1');
  } catch {
    /* ignore */
  }
  hevcOk = false;
}

let hevcOk: boolean | null = null;
/**
 * 网页端能不能解 HEVC（1080P）。
 *
 * 判定收紧到 canPlayType === 'probably'：Chrome/Firefox 一般只返回 ''，
 * 之前只要返回非空就算「能解」，于是菜单里冒出「超清 1080P」，一点就黑屏
 * （hls 拿到 HEVC 分片却塞不进 MSE），再靠报错回退，体验很差。
 * 现在只有真的声明「肯定能放」（Edge + 系统 HEVC 扩展）才给这一档。
 */
/** 上游 hevc 流的真实档次在 Level 4~5（L120/L150），按 L93 探测会误判成「不支持」 */
const HEVC_CODECS = [
  'hvc1.1.6.L150.90',
  'hvc1.1.6.L123.B0',
  'hvc1.1.6.L120.90',
  'hev1.1.6.L150.90',
  'hvc1.1.6.L93.B0',
];

export function canPlayHevc(): boolean {
  // App 内：解码器是原生 ExoPlayer，能不能解 HEVC 由原生探测结果说了算
  if (nativeMode) return nativeCaps().hevc1080;
  if (hevcOk === null) {
    try {
      const el = document.createElement('video');
      const viaVideo = HEVC_CODECS.some(
        (c) => el.canPlayType(`video/mp4; codecs="${c}"`) === 'probably',
      );
      const viaMse =
        typeof MediaSource !== 'undefined' &&
        HEVC_CODECS.some((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`));
      const broken = (() => {
        try {
          return localStorage.getItem(HEVC_BROKEN_KEY) === '1';
        } catch {
          return false;
        }
      })();
      hevcOk = viaVideo && !!viaMse && !broken;
    } catch {
      hevcOk = false;
    }
  }
  return hevcOk;
}

/**
 * 上游实际只有两路流：
 *   main   = H.264 / TS 分片（720P 左右）
 *   hevc   = HEVC / fMP4 分片（1080P，需要设备的 HEVC 硬解或系统解码器）
 * preview 和 main 是同一个地址，不算独立清晰度，所以不展示。
 */
export function availableQualities(): QualityKey[] {
  return canPlayHevc() ? ['main', 'hevc'] : ['main'];
}

/** 这一集上游有没有第二条 HEVC 流（网关只返回非空 manifest，空串不算） */
export function hasHevcStream(manifest?: Streams | null): boolean {
  const u = (manifest as any)?.hevc;
  return typeof u === 'string' && u.length > 0;
}

export const QUALITY_LABEL: Record<QualityKey, string> = {
  main: '高清 720P',
  hevc: '超清 1080P（HEVC）',
  preview: '流畅',
};

/** 默认清晰度：App 内（原生解码）直接上 HEVC，网页端还是稳一点先 720P */
export function defaultQuality(): QualityKey {
  return nativeMode && canPlayHevc() ? 'hevc' : 'main';
}

export interface PlayBundle {
  streams: Streams;
  manifest: Streams;
}

const cache = new Map<string, Promise<PlayBundle>>();
const key = (id: number | string, ep: number) => `${id}:${ep}`;

export function resolvePlay(id: number | string, ep: number): Promise<PlayBundle> {
  const k = key(id, ep);
  let p = cache.get(k);
  if (!p) {
    p = api.play(id, ep).catch((e) => {
      cache.delete(k);
      throw e;
    });
    cache.set(k, p);
  }
  return p;
}

/** 预加载下一集/下一部：只解析地址，不创建播放器。 */
export function preloadPlay(id: number | string, ep: number): void {
  resolvePlay(id, ep).catch(() => undefined);
  warmPlay(id, ep);
}

export interface AttachedPlayer {
  destroy(): void;
}

/** 把某一集挂到 <video>（或原生替身）上，返回销毁函数。 */
export async function attachStream(
  video: HTMLVideoElement | any,
  id: number | string,
  ep: number,
  onFatal?: () => void,
  prefer: QualityKey = 'main',
): Promise<AttachedPlayer> {
  // App 内：如果原生播放器里装着的就是这部这一集（三项都要对上：剧、集、流地址），
  // 直接沿用那条流，只把画面挂回当前位置 —— 不重新解析、不重新 open、不从 0 开始。
  // 注意这是「会话内接续」，不是历史记录；对不上就正常取流，绝不会串台。
  if (isNativeEl(video) && nativeMode) {
    const lp = livePlayback();
    if (lp && lp.vid === String(id) && lp.ep === ep && lp.uri && engine.uri === lp.uri) {
      video.attach(lp.uri, undefined, lp.t || 0);
      // 这条流本来就在播（画面早有了）：立刻告诉组件「已经有画面」，
      // 否则封面垫层要等 2.2 秒兜底才撤 —— 看着就是进播放页「转了一下在加载」
      if (engine.state.time > 0) {
        try {
          (video as any).readyState = 4;
          (video as any).emit?.('loadedmetadata');
          (video as any).emit?.('firstframe');
        } catch {
          /* noop */
        }
      }
      return {
        destroy: () => {
          /* 同一条流，不动原生播放器 */
        },
      };
    }
  }

  // 网页端同理：同一个 <video> 上挂的还是这一集（比如从「我的」切回首页），
  // 那就别重新建 hls、别重新 load——不然看着就是「回来从头加载」
  const keep = mounted.get(video as HTMLVideoElement);
  if (keep && keep.key === `${id}:${ep}:${prefer}`) {
    cancelDispose(video as HTMLVideoElement);
    try {
      (video as HTMLVideoElement).play?.()?.catch?.(() => undefined);
    } catch {
      /* noop */
    }
    return keep;
  }

  const { streams, manifest } = await resolvePlay(id, ep);
  // 有些集只有一路流，网关会给出空地址（/media/manifest?u=），必须当成没有
  const pick = (m?: string) => (m && m.includes('u=http') ? m : '');
  const src = abs(
    pick((manifest as any)[prefer]) ||
      pick(manifest.main) ||
      pick(manifest.hevc) ||
      (streams.main ? `/media/manifest?u=${encodeURIComponent(streams.main)}` : '') ||
      (streams.hevc ? `/media/manifest?u=${encodeURIComponent(streams.hevc)}` : ''),
  );
  if (!src) throw new Error('未拿到播放地址');

  // App 内：交给原生 ExoPlayer 硬解，这里不建 hls 实例
  if (isNativeEl(video)) {
    markPlay(id, ep, src);
    video.attach(src);
    return {
      destroy: () => {
        /* 原生播放器是全局复用的，销毁交给页面接管逻辑，不在这里断电 */
      },
    };
  }

  const { default: Hls } = await import('hls.js');
  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      // 前向缓冲拉长，播放过程中少卡顿
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1000 * 1000,
      // 回退缓冲保留一段，往回拖不用重新下
      backBufferLength: 30,
      // 拖动时容忍更小的缓冲空洞，出画面更快
      maxBufferHole: 0.5,
      // 提前取下一个分片
      startFragPrefetch: true,
      // 网络抖动时多重试几次，而不是直接报错
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 500,
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data?.fatal) {
        // 只有「解码/编码不兼容」才永久记住这台设备解不了 HEVC。
        // 网络抖动、分片超时这类一次性故障不许写进标记，否则偶发 502 会永久关掉 1080P。
        const details = String(data?.details || '');
        const codecFail = /bufferAppend|bufferAddCodec|bufferIncompatibleCodecs|manifestIncompatibleCodecs|mediaError/i.test(details);
        if (prefer === 'hevc' && (codecFail || data?.type === 'mediaError')) markHevcBroken();
        onFatal?.();
      }
    });
    const key = `${id}:${ep}:${prefer}`;
    const handle = {
      key,
      destroy: () => {
        deferDispose(video as HTMLVideoElement, () => {
          mounted.delete(video as HTMLVideoElement);
          hls.destroy();
        });
      },
    };
    mounted.set(video, handle);
    return handle;
  }
  // Safari / 原生 HLS
  const key2 = `${id}:${ep}:${prefer}`;
  video.src = src;
  mounted.set(video, {
    key: key2,
    destroy: () => {
      deferDispose(video, () => {
        mounted.delete(video);
        video.removeAttribute('src');
        video.load();
      });
    },
  });
  const safariHandle = mounted.get(video)!;
  return safariHandle;
}


/**
 * 预热：把 m3u8 和前两个分片用 fetch 拉到浏览器缓存里。
 * 真正播放时 hls.js 直接命中缓存，起播快很多。失败静默忽略。
 */
export function warmPlay(id: number | string, ep: number): void {
  resolvePlay(id, ep)
    .then(async ({ manifest }) => {
      const pickOne = (m?: string) => (m && m.includes('u=http') ? m : '');
      const src = pickOne((manifest as any).main) || pickOne((manifest as any).hevc) || '';
      if (!src) return;
      const url = abs(src);
      const text = await fetch(url).then((r) => (r.ok ? r.text() : ''));
      if (!text) return;
      const segs = text
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .slice(0, 2);
      segs.forEach((seg) => {
        const u = seg.startsWith('http') ? seg : abs(seg);
        fetch(u).catch(() => undefined);
      });
    })
    .catch(() => undefined);
}
