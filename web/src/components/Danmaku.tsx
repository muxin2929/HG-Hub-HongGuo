import type { CSSProperties } from 'react';

/**
 * 弹幕：从右往左飘过（不是静止停在屏幕上）。
 * 每条弹幕独立动画、时长略不同，循环播放。
 */
export function Danmaku({ lines, className = '' }: { lines: string[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <div className={`danmaku${className ? ' ' + className : ''}`}>
      {lines.map((t, i) => {
        const style: CSSProperties = {
          top: `${i * 34}px`,
          animationDuration: `${9 + (i % 3) * 1.6}s`,
          animationDelay: `${i * 2.4}s`,
        };
        return (
          <span className="dm" key={`${t}-${i}`} style={style}>
            {t}
          </span>
        );
      })}
    </div>
  );
}
