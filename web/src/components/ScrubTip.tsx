import { fmtDuration } from '../lib/format';

/**
 * 拖进度条时浮出来的那一小块：缩略帧 + 大号时间。
 * 首页、播放页、横屏页共用同一套皮，保证哪儿拖都一样。
 */
export function ScrubTip({
  url,
  time,
  dur,
  className = '',
  x,
}: {
  url?: string;
  time: number;
  dur: number;
  className?: string;
  /** 0-1：拖动位置在进度条上的比例，给了就让气泡横向跟着手指走 */
  x?: number;
}) {
  const style =
    x == null
      ? undefined
      : ({ '--sx': `${Math.max(9, Math.min(91, x * 100))}%` } as unknown as React.CSSProperties);
  return (
    <div className={`scrubtip ${className}`} style={style}>
      {/* 没有帧就给黑底：绝不拿破封面/上一张旧帧冒充，那会让人以为预览卡死了 */}
      <div className={`scrub-card${url ? '' : ' empty'}`}>
        {url ? <img src={url} alt="" /> : <span className="hg-spin tiny" />}
      </div>
      <div className="scrub-time">
        <b>{fmtDuration(time)}</b>
        <span>/{fmtDuration(dur)}</span>
      </div>
    </div>
  );
}
