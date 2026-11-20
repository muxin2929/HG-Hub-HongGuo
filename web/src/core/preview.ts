/**
 * 拖进度条时的「真帧」抓取器。
 *
 * 之前是「主播放器 seek 完直接 drawImage」，抓到的往往是 seek 之前那一帧，
 * 所以预览窗里永远是当前画面。这里单开一路不可见的解码实例：
 *   seek 到目标时间 → 等它真的解出这一帧（seeked）→ 再抓图
 * 全程只有一个实例、复用、松手时补最后一帧，不会越拖越卡。
 */
import { attachStream, type QualityKey } from './player';

type Cb = (url: string, t: number) => void;

const MIN_GAP = 60; // 两次 seek 的最小间隔：再密解码器也来不及，只会互相打架
/** "这一帧还没解出来"的哨兵：用它通知前端显示黑底，而不是继续挂着上一张旧帧 */
const BLACK = '__black';

export class FrameGrabber {
  private v: HTMLVideoElement;
  private player: any = null;
  private disposed = false;
  private cb: Cb | null = null;
  private want = -1;
  private busy = false;
  private lastSeekAt = 0;
  /** 这次 seek 发起的时间：超过 900ms 还没回来就认为卡住了，强制解锁重试 */
  private seekAt = 0;
  private timer = 0;
  private lastUrl = '';
  /** readyState 还没到 2 时重画的重试计数，以及连续黑帧的自限 */
  private repaint = 0;
  private blackN = 0;

  constructor(id: number | string, ep: number, quality: QualityKey) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    // 必须挂在文档里：离屏游离的 video 在部分 WebView 里不解码
    v.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(v);
    this.v = v;
    v.addEventListener('seeked', this.onSeeked);
    attachStream(v, id, ep, () => undefined, quality)
      .then((p) => {
        if (this.disposed) {
          try {
            p?.destroy?.();
          } catch {
            /* noop */
          }
          return;
        }
        this.player = p;
        // 关键补丁：hls 挂上以后如果一直不 play，部分 MSE/WebView 实现不会去取分片，
        // 于是「seek 到哪都只有第一帧」。先静音起播一下再立刻暂停，走一遍正常取流路径，
        // 之后每次 seek 才有真帧可抓。
        const vv = this.v;
        vv.play()
          .then(() => {
            try {
              vv.pause();
            } catch {
              /* noop */
            }
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }

  /** 拖动时持续调用：尽力跟到 t，能给就给一张真帧 */
  push(t: number, cb: Cb) {
    if (this.disposed) return;
    this.cb = cb;
    this.want = t;
    // busy 卡死是「预览永远同一张」的真凶：seeked 不一定每台机器都来，
    // 超过 450ms 还等不到就强制解锁，并先把预览刷成黑底（别再挂着上一张糊弄人）
    if (this.busy && performance.now() - this.seekAt > 450) {
      this.busy = false;
      if (this.lastUrl && this.lastUrl !== BLACK) {
        this.lastUrl = BLACK;
        this.cb('', this.want);
      }
    }
    if (this.busy) return; // 正在等 seeked，回来后会自己追新的目标
    const now = performance.now();
    if (now - this.lastSeekAt < MIN_GAP) {
      this.arm();
      return;
    }
    this.seekNow();
  }

  /** 松手：一定要把最后一帧补出来 */
  flush(t: number, cb: Cb) {
    if (this.disposed) return;
    this.cb = cb;
    this.want = t;
    this.busy = false;
    this.seekNow();
  }

  private arm() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.busy) this.seekNow();
    }, MIN_GAP);
  }

  private seekNow() {
    const v = this.v;
    if (this.disposed || !this.cb || this.want < 0) return;
    if (!v.duration || !Number.isFinite(v.duration)) {
      this.arm(); // 还没拿到时长，稍后再试
      return;
    }
    this.repaint = 0;
    this.blackN = 0;
    const t = Math.max(0, Math.min(v.duration - 0.04, this.want));
    // 本来就停在这一帧附近（比如连续微调），直接把当前帧给它
    if (Math.abs(v.currentTime - t) < 0.12 && v.readyState >= 2) {
      this.paint();
      return;
    }
    this.busy = true;
    this.lastSeekAt = performance.now();
    this.seekAt = this.lastSeekAt;
    try {
      v.currentTime = t;
    } catch {
      this.busy = false;
    }
  }

  private onSeeked = () => {
    this.busy = false;
    this.paint();
    // 手指还在移动：追最新目标
    if (this.cb && this.want >= 0 && Math.abs(this.v.currentTime - this.want) > 0.12) this.arm();
  };

  private paint() {
    const v = this.v;
    const cb = this.cb;
    if (!cb) return;
    // seeked 来了但还没解出画面（readyState 不足）：等一小会儿重画，
    // 不能就这么丢掉 —— 丢掉就是「预览停在上一帧不动」
    if (v.readyState < 2) {
      if (this.repaint < 3) {
        this.repaint += 1;
        window.setTimeout(() => {
          if (!this.disposed) this.paint();
        }, 180);
      }
      return;
    }
    const cv = document.createElement('canvas');
    cv.width = 192;
    cv.height = 108;
    const draw = () => {
      try {
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, 192, 108);
        const url = cv.toDataURL('image/jpeg', 0.62);
        // 分片还没到时会解出全黑：这时候宁可让前端显示黑底（告知"正在取帧"），
        // 也不能把上一张旧帧继续挂着 —— 那样看着就是"预览永远同一张"。
        if (this.isBlack(ctx, cv.width, cv.height)) {
          if (this.lastUrl !== BLACK) {
            this.lastUrl = BLACK;
            cb('', v.currentTime);
          }
          this.busy = false;
          // 自动重试几次，等分片到；再不行就等下一次鼠标驱动（别原地死循环）
          if (this.blackN < 3) {
            this.blackN += 1;
            this.arm();
          }
          return;
        }
        this.blackN = 0;
        if (url === this.lastUrl) return;
        this.lastUrl = url;
        cb(url, v.currentTime);
      } catch {
        /* 跨域 / 还没解出帧 */
      }
    };
    const anyV = v as any;
    if (typeof anyV.requestVideoFrameCallback === 'function') {
      let done = false;
      anyV.requestVideoFrameCallback(() => {
        if (done) return;
        done = true;
        draw();
      });
      // paused 状态下个别机型不回调，兜一下
      window.setTimeout(() => {
        if (done) return;
        done = true;
        draw();
      }, 140);
    } else {
      draw();
    }
  }

  /** 抓到的画面是不是全黑（分片没到 / 解码空档） */
  private isBlack(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
    try {
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        n += 1;
      }
      return n > 0 && sum / n < 10;
    } catch {
      // 跨域污染读不了像素：当作不是黑的，照常推
      return false;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.v.removeEventListener('seeked', this.onSeeked);
    try {
      this.player?.destroy?.();
    } catch {
      /* noop */
    }
    this.player = null;
    try {
      this.v.removeAttribute('src');
      this.v.load();
    } catch {
      /* noop */
    }
    this.v.remove();
  }
}
