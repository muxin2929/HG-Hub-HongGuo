import { useEffect, useRef, useState } from 'react';
import { api, playErrorText } from '../data/api';
import type { Video } from '../data/types';
import { Icon } from './Icons';
import { fmtDuration } from '../lib/format';
import { addHistory, getProgress, setProgress } from '../core/store';
import { auth } from '../core/auth';

/**
 * 全屏播放层。
 *   POST /api/play {id,ep} → 网关返回改写后的 manifest → hls.js 只跟本站说话。
 * 点击标题进详情页；播放进度每 5 秒落盘，下次进来续播。
 */
export function PlayerView({
  video,
  ep,
  onClose,
  onOpenDetail,
}: {
  video: Video;
  ep: number;
  onClose: () => void;
  onOpenDetail: (id: number) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<any>(null);
  const lastSave = useRef(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [cur, setCur] = useState(ep);
  const [tip, setTip] = useState('正在解析播放地址…');
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const total = video.episode_count || video.total_episodes || 1;

  /** 进度条点击/拖动跳转 */
  const seekAt = (track: HTMLElement, clientX: number) => {
    const el = ref.current;
    const r = track.getBoundingClientRect();
    if (!el || !el.duration || !r.width) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    try {
      el.currentTime = ratio * el.duration;
      setTime(ratio * el.duration);
    } catch {
      /* noop */
    }
  };

  useEffect(() => {
    let alive = true;
    const el = ref.current;
    if (!el) return;

    (async () => {
      setTip('正在解析播放地址…');
      try {
        const { streams, manifest } = await api.play(video.id, cur);
        if (!alive) return;
        const src =
          manifest.main ||
          manifest.hevc ||
          (streams.main ? `/media/manifest?u=${encodeURIComponent(streams.main)}` : '');
        if (!src) throw new Error('no stream');

        const { default: HlsCtor } = await import('hls.js');
        if (!alive) return;
        if (HlsCtor.isSupported()) {
          hlsRef.current?.destroy?.();
          const hls = new HlsCtor({ maxBufferLength: 30, enableWorker: true });
          hlsRef.current = hls;
          hls.loadSource(src);
          hls.attachMedia(el);
          hls.on(HlsCtor.Events.ERROR, (_e: any, data: any) => {
            if (data?.fatal) setTip('播放中断，正在重试…');
          });
          setTip('');
          el.muted = false;
          el.play().catch(() => {
            el.muted = true;
            el.play().catch(() => setTip('点击画面开始播放'));
          });
        } else {
          el.src = src;
          setTip('');
          el.play().catch(() => {
            el.muted = true;
            el.play().catch(() => setTip('点击画面开始播放'));
          });
        }

        // 续播：上次看到一半，自动跳回
        const p = getProgress(video.id);
        if (p && p.ep === cur && p.t > 10 && p.dur && p.t < p.dur - 10) {
          const seek = () => {
            try {
              el.currentTime = p.t;
            } catch {
              /* noop */
            }
          };
          el.addEventListener('loadedmetadata', seek, { once: true });
          window.setTimeout(seek, 800);
        }
        addHistory(video, cur);
      } catch (e: any) {
        if (!alive) return;
        setTip(
          api.mockMode
            ? '演示数据 · 未连接网关'
            : `${playErrorText(e?.message)}\n点左上角关闭返回`,
        );
      }
    })();

    return () => {
      alive = false;
      hlsRef.current?.destroy?.();
      hlsRef.current = null;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* noop */
      }
    };
  }, [video.id, cur]);

  return (
    <div className="player">
      <video
        ref={ref}
        playsInline
        autoPlay
        controls={false}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setTime(el.currentTime);
          const now = Date.now();
          if (now - lastSave.current > 5000 && el.duration) {
            lastSave.current = now;
            setProgress(video.id, cur, el.currentTime, el.duration);
          }
        }}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onClick={(e) => {
          const v = e.currentTarget;
          if (v.paused) v.play().catch(() => undefined);
          else v.pause();
        }}
      />
      <button type="button" className="pclose" onClick={onClose} aria-label="关闭">
        <Icon name="close" size={19} />
      </button>
      <button
        type="button"
        className="pfs"
        aria-label="全屏"
        onClick={async () => {
          const el = ref.current?.parentElement || ref.current;
          try {
            if (!document.fullscreenElement) await el?.requestFullscreen?.();
            else await document.exitFullscreen?.();
          } catch {
            /* 不支持就算了 */
          }
        }}
      >
        <Icon name="fullscreen" size={18} strokeWidth={1.9} />
      </button>
      {tip && (
        <div className="ptip" style={{ whiteSpace: 'pre-line' }}>
          {tip}
        </div>
      )}
      <div className="pbar">
        <button
          type="button"
          className="ptitle"
          onClick={() => onOpenDetail(video.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 8,
            color: '#fff',
            background: 'none',
            border: 0,
            padding: 0,
            maxWidth: '100%',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {video.title} · 第 {cur} 集
          </span>
          <Icon name="chevron" size={13} strokeWidth={2.2} />
        </button>
        <div
          className="ptrack"
          ref={trackRef}
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            dragging.current = true;
            seekAt(e.currentTarget, e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekAt(e.currentTarget, e.clientX);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            seekAt(e.currentTarget, e.clientX);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <i style={{ width: `${dur ? Math.min(100, (time / dur) * 100) : 0}%` }} />
        </div>
        <div className="prow" style={{ marginBottom: 10 }}>
          <span>{fmtDuration(time)}</span>
          <span style={{ opacity: 0.6 }}>/ {fmtDuration(dur)}</span>
          <span style={{ marginLeft: 'auto', opacity: 0.75 }}>共 {total} 集</span>
        </div>
        <div className="eps">
          {Array.from({ length: Math.min(total, 30) }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" className={n === cur ? 'on' : ''} onClick={() => setCur(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
