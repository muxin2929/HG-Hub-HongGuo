import { useEffect, useReducer, useRef, useState } from 'react';
import type { Video } from '../data/types';
import { coverUrl, playErrorText } from '../data/api';
import { canPlayHevc, attachStream, availableQualities, hasHevcStream, QUALITY_LABEL, resolvePlay, type AttachedPlayer, type QualityKey } from '../core/player';
import { getProgress, addHistory, setProgress } from '../core/store';
import { isFav, isLiked, subscribeMarks, toggleFav, toggleLike } from '../core/marks';
import { auth } from '../core/auth';
import { fmtDuration, fmtNum } from '../lib/format';
import { useCommentCount } from '../core/useCommentCount';
import { Icon } from './Icons';
import { ScrubTip } from './ScrubTip';
import { FrameGrabber } from '../core/preview';
import { useLongPressBoost } from '../core/boost';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2, 3];
const RANGE = 30;

/** PC 专用剧集播放页：左视频 + 右信息/选集，浮窗选集，不做手机那种覆盖式布局。 */
export function EpisodePlayerPC({
  video,
  ep,
  onClose,
  onDetail,
  onComment,
  onShare,
  onToast,
}: {
  video: Video;
  ep: number;
  onClose: () => void;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onToast: (t: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<AttachedPlayer | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const saveAt = useRef(0);

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
  // 列表里可能没有评论数（首页/榜单来源），按需补详情
  const cmtN = useCommentCount(video);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  // 缓冲时为 true：中央显示转圈，而不是一个看起来「可播但没播」的三角
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [quality, setQuality] = useState<QualityKey>('main');
  const [effQuality, setEffQuality] = useState<QualityKey>('main');
  const [hasHevc, setHasHevc] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [range, setRange] = useState(Math.floor((ep - 1) / RANGE));
  // 收藏/点赞和首页/竖屏/我的页是同一份全局状态
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);
  const [tip, setTip] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  /** 松手续播的观察期：这段时间不亮中央播放三角（拖动不是暂停） */
  const [scrubTail, setScrubTail] = useState(false);
  const scrubTailT = useRef(0);
  /** 拖动自己引起的 pause 不算用户暂停（不然中央会冒出播放三角） */
  const scrubPauseRef = useRef(false);
  const markPaused = () => {
    if (scrubPauseRef.current) return;
    setPaused(true);
  };
  const [frame, setFrame] = useState<{ url: string; time: number } | null>(null);
  const scrubOn = useRef(false);
  const scrubAt = useRef(0);
  const dragRef = useRef(false);
  const grabberRef = useRef<FrameGrabber | null>(null);
  const [scrubX, setScrubX] = useState(0);
  const scrubWasPlaying = useRef(false);
  /** 鼠标悬停在进度条上：只出预览帧，主画面继续播，不动进度 */
  const [hoverOn, setHoverOn] = useState(false);
  const [hoverT, setHoverT] = useState(0);
  const [hoverX, setHoverX] = useState(0);
  const hoverTmr = useRef(0);
  const hoverKey = useRef(-1);
  /** 已经抓到的帧按 0.5s 一档缓存，来回划同一条不用反复解码 */
  const frameCache = useRef(new Map<number, string>());
  // 长按画面 = 临时 2 倍速
  const [boostOn, setBoostOn] = useState(false);
  const tapGuard = useRef(false);
  const downPt = useRef({ x: 0, y: 0 });
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

  // 换集 / 换清晰度 / 退出时把预览解码器收掉
  useEffect(() => {
    return () => {
      grabberRef.current?.dispose();
      grabberRef.current = null;
      window.clearTimeout(hoverTmr.current);
      hoverKey.current = -1;
      frameCache.current.clear();
      setHoverOn(false);
    };
  }, [video.id, cur, quality]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    let alive = true;
    (async () => {
      try {
        const keep = el.currentTime || 0;
        const bundle = await resolvePlay(video.id, cur);
        const hevcOk = canPlayHevc() && hasHevcStream(bundle.manifest);
        setHasHevc(hevcOk);
        const actual: QualityKey = quality === 'hevc' && hevcOk ? 'hevc' : 'main';
        setEffQuality(actual);
        playerRef.current?.destroy();
        playerRef.current = await attachStream(el, video.id, cur, onFatal, actual);
        if (!alive) return;
        el.playbackRate = speed;
        if (keep > 1) {
          const seek = () => {
            try {
              el.currentTime = keep;
            } catch {
              /* noop */
            }
          };
          el.addEventListener('loadedmetadata', seek, { once: true });
          window.setTimeout(seek, 400);
        }
        await el.play().catch(() => undefined);
        if (cur === ep) {
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
  }, [video.id, cur, quality]);

  // 时长兜底：有些机器上 loadedmetadata 那一下没进 React 回调，state 里的 dur 一直是 0，
  // 表现出来就是「进度条不动、悬停/拖动预览都不出」。这里定期和元素对一次。
  useEffect(() => {
    const iv = window.setInterval(() => {
      const d = Number(videoRef.current?.duration || 0);
      if (d > 0) setDur((x) => (Math.abs(x - d) > 0.5 ? d : x));
    }, 700);
    return () => window.clearInterval(iv);
  }, [video.id, cur, quality]);

  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);
  useEffect(() => {
    userPausedRef.current = userPaused;
  }, [userPaused]);
  const openAt = useRef(Date.now());

  const togglePlay = () => {
    if (Date.now() - openAt.current < 520) return; // 吃掉「进入播放页那一下」漏进来的点击
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

  /**
   * PC 端键盘操作（桌面用户最常用的那几个）：
   *   空格 / K  播放暂停     ← →  快退快进 5 秒
   *   ↑ ↓       音量        M    静音        F    全屏淡入
   * 在输入框里打字时不抢键。
   */
  // 键盘监听只挂一次（依赖 []），闭包里拿到的都是首帧的 state ——
  // 而 togglePlay 里要用 loading/seeking 判断，首帧 loading 恒为 true，
  // 结果按空格永远被 return 掉（这正是一直觉得「空格时灵时不灵」的原因）。
  // 这里每次渲染把最新那个 togglePlay 塞进 ref，监听里调 ref。
  const toggleRef = useRef(togglePlay);
  toggleRef.current = togglePlay;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = videoRef.current;
      if (!el) return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          toggleRef.current();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.volume = Math.min(1, el.volume + 0.1);
          if (el.muted) {
            el.muted = false;
            setMuted(false);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          el.volume = Math.max(0, el.volume - 0.1);
          break;
        case 'm':
        case 'M':
          el.muted = !el.muted;
          setMuted(el.muted);
          break;
        case 'f':
        case 'F':
          setExpanded((v) => !v);
          break;
        case 'Escape':
          setExpanded(false);
          setShowQuality(false);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const seekAt = (track: HTMLElement, clientX: number, final = false) => {
    const el = videoRef.current;
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const total = el?.duration || dur;
    if (!total) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const at = ratio * total;
    scrubAt.current = at;
    // 拖动过程中气泡也停在手指这里（松手后悬停时继续用它，不会跳回旧位置）
    setHoverOn(true);
    setHoverX(ratio);
    setHoverT(at);
    // 进度条立刻跟手，真正跳转放在松手那一下
    setTime(at);
    setScrubX(ratio);
    grabPreview(at, final);
    if (final && el) {
      try {
        el.currentTime = at;
      } catch {
        /* noop */
      }
      setTime(at);
    }
  };

  /** 目标时间那一帧的真图：走独立解码实例，避免抓到 seek 之前的旧画面 */
  const grabPreview = (at: number, final: boolean) => {
    if (!videoRef.current) return;
    if (!grabberRef.current) grabberRef.current = new FrameGrabber(video.id, cur, effQuality);
    const g = grabberRef.current;
    if (final) g.flush(at, (url, t) => setFrame({ url, time: t }));
    else g.push(at, (url, t) => setFrame({ url, time: t }));
  };

  /**
   * 悬停预览：只取那一帧来显示，poke 的都是独立的静默解码实例，
   * 主播放器不 seek、不暂停，画面照常往下走。
   */
  const hoverPeek = (at: number) => {
    const key = Math.round(at * 4) / 4; // 0.25 秒一档
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    const hit = frameCache.current.get(key);
    if (hit) {
      setFrame({ url: hit, time: key });
      return;
    }
    // 还没抓到：先黑底转圈，不要挂着上一格的画面骗人
    setFrame({ url: '', time: key });
    window.clearTimeout(hoverTmr.current);
    hoverTmr.current = window.setTimeout(() => {
      if (!videoRef.current) return;
      if (!grabberRef.current) grabberRef.current = new FrameGrabber(video.id, cur, effQuality);
      grabberRef.current.push(key, (url, t) => {
        if (url && url !== '__black') frameCache.current.set(key, url);
        // 鼠标已经划走了就不盖掉新的那格
        if (hoverKey.current === key) setFrame({ url, time: t });
      });
    }, 70);
  };

  const ranges: Array<[number, number]> = [];
  for (let s = 1; s <= total; s += RANGE) ranges.push([s, Math.min(total, s + RANGE - 1)]);
  const curRange = ranges[range] || [1, total];
  const eps: number[] = [];
  for (let n = curRange[0]; n <= curRange[1]; n++) eps.push(n);
  /**
   * 时长以元素自己的为准：只信 state 会出现「进去半天进度条不动、悬停预览也不出」——
   * 有些机器上 loadedmetadata 这一下没进 React 回调，duration 其实早就有了。
   */
  const durNow = dur || Number(videoRef.current?.duration || 0) || 0;
  const pct = durNow ? Math.min(100, (time / durNow) * 100) : 0;
  const desc = (video.description || '暂无简介').replace(/\s+/g, ' ');

  return (
    <div className={`eplayer pc${scrubbing ? ' scrubbing' : ''}`}>
      <div className="epc-main">
        <video
          ref={videoRef}
          className="epc-video"
          playsInline
          preload="auto"
          poster={coverUrl(video.cover)}
          onClick={() => {
            if (tapGuard.current) {
              tapGuard.current = false;
              return; // 长按快放抬手那一下，不当作点击
            }
            togglePlay();
          }}
          onPointerDown={(e) => {
            downPt.current = { x: e.clientX, y: e.clientY };
            hold.down();
          }}
          onPointerMove={(e) => {
            hold.move(e.clientX - downPt.current.x, e.clientY - downPt.current.y);
          }}
          onPointerUp={() => {
            if (hold.up()) {
              tapGuard.current = true;
              window.setTimeout(() => {
                tapGuard.current = false;
              }, 320);
            }
          }}
          onPointerCancel={() => {
            hold.cancel();
          }}
          onDoubleClick={() => setExpanded(true)}
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
        {(userPaused || loading || paused) && (
          <button
            type="button"
            className="epc-bigplay"
            onClick={togglePlay}
            aria-label={userPaused ? '播放' : '加载中'}
          >
            {userPaused ? <Icon name="play" size={40} strokeWidth={2} /> : <span className="hg-spin big" />}
          </button>
        )}
        {tip && <div className="epc-tip">{tip}</div>}
        {boostOn && <div className="epc-boost">2 倍速播放中</div>}

        <div className="epc-bar">
          <button type="button" className="epc-btn" onClick={togglePlay}>
            <Icon name={paused ? 'play' : 'pause'} size={18} strokeWidth={2} />
          </button>
          <span className="epc-time">
            {fmtDuration(time)} / {fmtDuration(durNow)}
          </span>
          <div
            className={`epc-prog${scrubbing ? ' on' : ''}`}
            ref={trackRef}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              dragRef.current = true;
              scrubOn.current = true;
              setScrubbing(true);
              setFrame(null);
              const el: any = videoRef.current;
              scrubWasPlaying.current = !!el && !el.paused;
              try {
                el?.pause?.();
              } catch {
                /* noop */
              }
              if (scrubWasPlaying.current) {
                scrubPauseRef.current = true;
                setPaused(false);
              }
              seekAt(e.currentTarget, e.clientX);
            }}
            onPointerMove={(e) => {
              if (dragRef.current) {
                seekAt(e.currentTarget, e.clientX);
                return;
              }
              // 没按下：只做悬停预览，不动进度、不动主画面
              const r = e.currentTarget.getBoundingClientRect();
              if (!r.width) return;
              const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
              const total = videoRef.current?.duration || dur;
              if (!total) return;
              setHoverOn(true);
              setHoverX(ratio);
              setHoverT(ratio * total);
              hoverPeek(ratio * total);
            }}
            onPointerLeave={() => {
              if (dragRef.current) return;
              setHoverOn(false);
              hoverKey.current = -1;
              window.clearTimeout(hoverTmr.current);
            }}
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
            {(hoverOn || scrubbing) && durNow > 0 && (
              <ScrubTip
                className="eprev"
                url={frame?.url}
                time={scrubbing ? time : hoverT}
                dur={durNow}
                x={scrubbing ? scrubX : hoverX}
              />
            )}
            <i style={{ width: `${pct}%` }} />
          </div>
          <button type="button" className="epc-btn" onClick={() => setShowQuality(true)}>
            {QUALITY_LABEL[effQuality].split(' ')[1] || '720P'}
          </button>
          <button
            type="button"
            className="epc-btn"
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
              setSpeed(next);
              const el = videoRef.current;
              if (el) el.playbackRate = next;
            }}
          >
            {speed.toFixed(2).replace(/\.00$/, '.0')}x
          </button>
          <button
            type="button"
            className="epc-btn"
            onClick={() => {
              setMuted((m) => !m);
              const el = videoRef.current;
              if (el) el.muted = !muted;
            }}
          >
            <Icon name={muted ? 'mute' : 'vol'} size={17} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <aside className="epc-side">
        <div className="epc-head">
          <button type="button" className="epc-back" onClick={onClose} aria-label="返回">
            <Icon name="back" size={18} strokeWidth={2.2} />
          </button>
          <button type="button" className="epc-name" onClick={() => onDetail(video.id)}>
            {video.title}
          </button>
          <span className="epc-cur">第{cur}集</span>
        </div>

        <div className="epc-meta">
          {video.is_finished ? '已完结' : '连载中'} · 全{total}集 · {fmtNum(video.hot_count)}热度
        </div>

        <div className="epc-acts">
          <button
            type="button"
            className={`epc-act${isFav(video.id) ? ' on' : ''}`}
            onClick={() => {
              void toggleFav(video).then(() => bumpMarks());
            }}
          >
            <Icon name={isFav(video.id) ? 'starFill' : 'star'} size={16} strokeWidth={1.8} />
            {fmtNum((video.collect_count || 0) + (isFav(video.id) ? 1 : 0))}
          </button>
          <button
            type="button"
            className={`epc-act${isLiked(video.id) ? ' on' : ''}`}
            onClick={() => {
              void toggleLike(video).then(() => bumpMarks());
            }}
          >
            <Icon name={isLiked(video.id) ? 'heartFill' : 'heart'} size={16} strokeWidth={1.8} />
            {fmtNum((video.like_count || 0))}
          </button>
          <button type="button" className="epc-act" onClick={() => onComment(video)}>
            <Icon name="chat" size={16} strokeWidth={1.8} />
            {fmtNum(cmtN)}
          </button>
          <button type="button" className="epc-act" onClick={() => onShare(video, cur)}>
            <Icon name="share" size={16} strokeWidth={1.8} />
            分享
          </button>
        </div>

        <div className={`epc-desc${expanded ? ' open' : ''}`} onClick={() => setExpanded((v) => !v)}>
          {desc}
          <span className="emore">{expanded ? ' 收起' : ' 展开'}</span>
        </div>

        <div className="epc-eplist">
          <div className="epc-eplist-head">
            <span>选集</span>
            <span className="epc-eplist-sub">
              {video.is_finished ? '已完结' : '连载中'} · 全{total}集
            </span>
          </div>
          {ranges.length > 1 && (
            <div className="epc-ranges">
              {ranges.map(([a, b], i) => (
                <button key={a} type="button" className={i === range ? 'on' : ''} onClick={() => setRange(i)}>
                  {a}-{b}
                </button>
              ))}
            </div>
          )}
          <div className="epc-eps">
            {eps.map((n) => (
              <button
                key={n}
                type="button"
                className={n === cur ? 'on' : ''}
                onClick={() => setCur(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="epc-open" onClick={onClose}>
          <Icon name="play" size={15} strokeWidth={2} />
          回到推荐
        </button>
      </aside>

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
                    onToast(`已切换到 ${QUALITY_LABEL[q]}`);
                  }}
                >
                  {QUALITY_LABEL[q]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <button type="button" className="epc-fav-fab" onClick={() => onToast('更多：举报 / 反馈')}>
        <Icon name="more" size={16} strokeWidth={2} />
      </button>
    </div>
  );
}
