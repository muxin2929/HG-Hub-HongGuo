import { useState } from 'react';
import type { Video } from '../data/types';
import { Icon } from './Icons';

const RANGE = 30;

/** 选集框：点数字即刻切换，不再有确认按钮，也不再混清晰度。 */
export function EpisodePicker({
  video,
  current,
  onPick,
  onClose,
}: {
  video: Video;
  current: number;
  onPick: (ep: number) => void;
  onClose: () => void;
}) {
  const total = video.episode_count || video.total_episodes || 1;
  const [range, setRange] = useState(Math.floor((current - 1) / RANGE));

  const ranges: Array<[number, number]> = [];
  for (let s = 1; s <= total; s += RANGE) ranges.push([s, Math.min(total, s + RANGE - 1)]);
  const curRange = ranges[range] || [1, total];
  const eps: number[] = [];
  for (let n = curRange[0]; n <= curRange[1]; n++) eps.push(n);

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className="picksheet">
        <div className="eps-head">
          <span>选集</span>
          <span className="eps-sub">
            {video.is_finished ? '已完结' : '连载中'} · 全{total}集
          </span>
          <button type="button" className="pick-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} strokeWidth={2} />
          </button>
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
              className={n === current ? 'on' : ''}
              onClick={() => {
                onPick(n);
                onClose();
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
