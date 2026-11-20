import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import { auth, getToken } from '../core/auth';
import { engine, nativeMode } from '../core/native';
import { isFav, isLiked, loadMarks, subscribeMarks, toggleFav, toggleLike } from '../core/marks';
import type { Video } from '../data/types';
import { MOCK_DANMAKU } from '../data/mock';
import { defaultQuality, preloadPlay, type QualityKey } from '../core/player';
import { getProgress } from '../core/store';
import { useIsDesktop } from '../core/useDesktop';
import { danmakuOf } from '../lib/format';
import { FeedSlide } from './FeedSlide';
import { EpisodePicker } from './EpisodePicker';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 单个频道的 feed。
 * 三个频道各有一个实例、各自持有列表/滚动/播放器，
 * 切换频道只是 display 切换，组件不卸载 → 回来不重新加载、进度接着播。
 */
export function ChannelFeed({
  chan,
  cate,
  on,
  refreshKey = 0,
  resumeKey = 0,
  suspend = false,
  epSync = null,
  onOpen,
  onDetail,
  onComment,
  onShare,
  onLandscape,
  onToast,
  onCount,
}: {
  chan: string;
  cate?: string;
  on: boolean;
  refreshKey?: number;
  resumeKey?: number;
  suspend?: boolean;
  /** 播放页退出时回传的「这部看到第几集」：首页要停在同一集，不能永远第一集 */
  epSync?: { vid: number; ep: number; k: number } | null;
  onOpen: (v: Video, ep: number, at?: number) => void;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onLandscape: (v: Video, ep: number, at?: number) => void;
  onToast: (t: string) => void;
  onCount?: (n: number, active: number) => void;
}) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const lastLoadRef = useRef(0);
  const activeRef = useRef(0);
  const usedPages = useRef<Set<number>>(new Set());
  const totalPages = useRef(1);
  const lastCate = useRef<string | undefined>(undefined);
  /** 手势拖拽状态：dy 是相对当前那一屏的位移（px） */
  const dragRef = useRef({ on: false, y0: 0, dy: 0, t0: 0, moved: false, raf: 0 });
  const animRef = useRef(0);

  const [items, setItems] = useState<Video[]>([]);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [quality, setQuality] = useState<QualityKey>(defaultQuality());
  const [eps, setEps] = useState<Record<number, number>>({});
  const [picker, setPicker] = useState<Video | null>(null);
  const [total, setTotal] = useState(0);
  const [end, setEnd] = useState(false);
  const [failed, setFailed] = useState(false);
  
  const isDesktop = useIsDesktop();

  /**
   * 真随机池：优先走网关的每日剧库快照（/api/feed/random）——那里面按热度加权、
   * 并把「最近看过的 id」排除掉，所以不会再来来回回那几个。
   * 快照还没抓好（网关返回 status:0）时才回退到老的翻页攒池子。
   */
  const pool = useRef<Video[]>([]);
  const poolIds = useRef<Set<number>>(new Set());
  const pagesLeft = useRef<number[]>([]);
  const poolInited = useRef(false);
  /** 全局「最近看过」，跨会话保存在本地，只留最近 500 个 */
  const seenRef = useRef<number[] | null>(null);
  const catalogRef = useRef<boolean | null>(null);
  const itemsRef = useRef<Video[]>([]);

  const loadSeen = () => {
    try {
      const raw = localStorage.getItem('hgr/seenIds');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'number') : [];
    } catch {
      return [];
    }
  };
  const pushSeen = (ids: number[]) => {
    const base = seenRef.current || loadSeen();
    const now = [...base, ...ids];
    const uniq = Array.from(new Set(now)).slice(-500);
    seenRef.current = uniq;
    try {
      localStorage.setItem('hgr/seenIds', JSON.stringify(uniq));
    } catch {
      /* 配额满就算了 */
    }
  };

  const resetPool = () => {
    pool.current = [];
    poolIds.current = new Set();
    pagesLeft.current = [];
    poolInited.current = false;
    totalPages.current = 1;
  };

  /** 从池子里取一批；池子不够就去随机翻几页补货（快照不可用时的老路子） */
  const fetchBatch = useCallback(async (want: number): Promise<{ items: Video[]; pages: number; total: number }> => {
    if (lastCate.current !== cate) {
      lastCate.current = cate;
      usedPages.current = new Set();
      resetPool();
    }

    // ① 先试每日剧库快照
    if (catalogRef.current !== false) {
      try {
        const seen = seenRef.current || (seenRef.current = loadSeen());
        const ex = Array.from(new Set([...seen, ...itemsRef.current.map((v) => v.id)]));
        const r = await api.feedRandom(want, cate || '', ex);
        if (r.items.length) {
          catalogRef.current = true;
          pushSeen(r.items.map((v) => v.id));
          return { items: r.items, pages: 1, total: r.items.length };
        }
        catalogRef.current = false;
      } catch {
        catalogRef.current = false;
      }
    }

    let total = 0;
    let firstBatch = false;
    if (!poolInited.current) {
      firstBatch = true;
      poolInited.current = true;
      const first = await api.videos(1, cate);
      totalPages.current = Math.max(1, first.pagination.pages);
      total = first.pagination.total;
      usedPages.current.add(1);
      pagesLeft.current = [];
      for (let i = 2; i <= totalPages.current; i++) pagesLeft.current.push(i);
      shuffle(first.items).forEach((v) => {
        if (poolIds.current.has(v.id)) return;
        poolIds.current.add(v.id);
        pool.current.push(v);
      });
    }

    // 池子不够就再抽几页（最多 4 次请求，别一次把网络打满）。
    // 首次至少攒到 40 部再发牌：否则开头永远是「第 1 页那 20 部换个顺序」，
    // 看起来就是「来来回回那几个」。
    const minSize = firstBatch ? 40 : want;
    let tries = 0;
    while (pool.current.length < minSize && pagesLeft.current.length && tries < 5) {
      tries++;
      const k = Math.floor(Math.random() * pagesLeft.current.length);
      const page = pagesLeft.current.splice(k, 1)[0];
      try {
        const p = await api.videos(page, cate);
        totalPages.current = Math.max(totalPages.current, p.pagination.pages);
        total = p.pagination.total || total;
        usedPages.current.add(page);
        shuffle(p.items).forEach((v) => {
          if (poolIds.current.has(v.id)) return;
          poolIds.current.add(v.id);
          pool.current.push(v);
        });
      } catch {
        /* 某一页失败就跳过，别把整条 feed 拖死 */
      }
    }

    if (!total) total = usedPages.current.size;
    shuffle(pool.current);
    const items = pool.current.splice(0, Math.max(1, want));
    pushSeen(items.map((v) => v.id));
    return { items, pages: totalPages.current, total };
  }, [cate]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    if (Date.now() - lastLoadRef.current < 400) return;
    loadingRef.current = true;
    lastLoadRef.current = Date.now();
    try {
      const r = await fetchBatch(12);
      if (!r.items.length) {
        setEnd(true);
        return;
      }
      setTotal(r.total);
      setItems((prev) => {
        const seen = new Set(prev.map((v) => v.id));
        const add = r.items.filter((v) => !seen.has(v.id));
        return add.length ? [...prev, ...add] : prev;
      });
      // 同一批更新里把「这部看到第几集」灌进去（和 setItems 一起批量提交，
      // 不会出现 FeedSlide 先按第 1 集挂载、再被改成第 20 集的二次取流）。
      setEps((m) => {
        let changed = false;
        const next = { ...m };
        for (const v of r.items) {
          if (next[v.id]) continue;
          const p = getProgress(v.id);
          if (p && p.ep > 1) {
            next[v.id] = p.ep;
            changed = true;
          }
        }
        return changed ? next : m;
      });
      // 池子空了、也没有没取过的页 → 真的到头了
      if (!pool.current.length && !pagesLeft.current.length) setEnd(true);
    } catch {
      setFailed(true);
      setEnd(true);
    } finally {
      loadingRef.current = false;
    }
  }, [fetchBatch]);

  // 收藏/点赞状态统一走 core/marks（账号优先、全场互通），这里只订阅它的版本号
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);

  useEffect(() => {
    void loadMarks();
  }, []);

  // 首次挂载就拉一页
  useEffect(() => {
    if (items.length === 0 && !loadingRef.current) loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- 翻页（手势驱动）
  // 不用原生滚动：滚动的平滑是浏览器合成线程在做，网页算不到当前偏移，
  // 底下那张原生纹理就只能干等 JS 回报，于是「画面不跟手、上页还留在那」。
  // 改成自己算位移 + 每帧把新矩形报给原生层，画面和页面才是同一块。

  const pageH = () => feedRef.current?.clientHeight || 1;
  /** 第 idx 屏时整条轨道应该停在哪（负值向上） */
  const restY = (idx: number) => -idx * pageH();

  const setY = (y: number) => {
    const t = trackRef.current;
    if (t) t.style.transform = `translate3d(0,${Math.round(y)}px,0)`;
  };

  const syncNative = () => {
    if (nativeMode) engine.syncRect(true);
  };

  const glideTo = useCallback((idx: number, fromDy = 0) => {
    const start = restY(activeRef.current) + fromDy;
    const to = restY(idx);
    const dist = to - start;
    if (Math.abs(dist) < 1) {
      setY(to);
      syncNative();
      setActive((cur) => (cur === idx ? cur : idx));
      return;
    }
    const dur = Math.min(340, Math.max(160, Math.abs(dist) * 0.6));
    const t0 = performance.now();
    cancelAnimationFrame(animRef.current);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      // easeOutCubic：起步跟手，尾段收得住
      const e = 1 - Math.pow(1 - p, 3);
      setY(start + dist * e);
      syncNative();
      if (p < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        // 落位之后再换 active：新那一集这时候才开始取流，
        // 旧画面早已经被整屏推出去了，不会留在原位
        setY(restY(idx));
        syncNative();
        setActive(idx);
      }
    };
    animRef.current = requestAnimationFrame(step);
  }, []);

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(animRef.current);
    const d = dragRef.current;
    d.on = true;
    d.y0 = e.touches[0].clientY;
    d.dy = 0;
    d.t0 = Date.now();
    d.moved = false;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const d = dragRef.current;
    if (!d.on || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - d.y0;
    d.dy = dy;
    if (Math.abs(dy) > 12) d.moved = true;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      // 到头了加点阻尼，别整页跟着乱跑
      const top = activeRef.current <= 0 && dy > 0;
      const end = activeRef.current >= items.length - 1 && dy < 0;
      setY(restY(activeRef.current) + (top || end ? dy * 0.32 : dy));
      syncNative();
    });
  };

  const onTouchEnd = () => {
    const d = dragRef.current;
    if (!d.on) return;
    d.on = false;
    if (d.raf) {
      cancelAnimationFrame(d.raf);
      d.raf = 0;
    }
    if (d.moved) (window as any).__hgSwiped = performance.now();
    const h = pageH();
    const dt = Math.max(1, Date.now() - d.t0);
    const v = d.dy / dt;
    let dir = 0;
    if (d.dy < -h * 0.22 || v < -0.3) dir = 1;
    else if (d.dy > h * 0.22 || v > 0.3) dir = -1;
    const next = Math.max(0, Math.min(items.length - 1, activeRef.current + dir));
    glideTo(next, d.dy);
    if (next !== activeRef.current && next >= items.length - 5) loadMore();
    d.dy = 0;
  };

  const scrollTo = (idx: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    glideTo(clamped, 0);
    if (clamped >= items.length - 5) loadMore();
  };

  // active 变了就把轨道基准到对应那一屏（首次挂载 / 兜底对位）
  useEffect(() => {
    setY(restY(active));
    syncNative();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (active <= items.length - 5) return;
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items.length]);

  useEffect(() => {
    const sent = sentinelRef.current;
    if (!sent) return;
    // 哨兵只是列表末尾那一屏，翻到附近由 active 的变化触发续页
    void sent;
  }, [loadMore]);

  useEffect(() => {
    activeRef.current = active;
    onCount?.(items.length, active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items.length]);

  // items 同步进 ref（发牌时要拿现有 id 去排除重复）
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // 预取：当前 + 后两部的详情/评论/清单/封面
  useEffect(() => {
    const v = items[active];
    if (!v) return;
    api.prefetchVideo(v.id);
    api.prefetchComments(v.id);
    preloadPlay(v.id, 2);
    [items[active + 1], items[active + 2]].forEach((it) => {
      if (!it) return;
      api.prefetchVideo(it.id);
      preloadPlay(it.id, 1);
      const img = new Image();
      img.decoding = 'async';
      img.src = coverUrl(it.cover);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items.length]);

  // 隐藏时暂停（切频道/切 tab），回来继续，进度不丢
  useEffect(() => {
    const v = feedRef.current?.querySelector<HTMLVideoElement>('.slide.active video');
    if (!v) return;
    if (on) v.play().catch(() => undefined);
    else v.pause();
  }, [on]);

  // 从播放页 / 详情页关回首页：把当前这屏接着播起来（播放页里可能把它暂停过）
  useEffect(() => {
    if (!on || !resumeKey) return;
    if (nativeMode && engine.active?.slot === 'feed') {
      // 原生层交还（engine.release）之后，这里补一记画面和播控，避免停在「已就位但不动」。
      // 没有 feed 占着画面（比如冷启动还没取流）就别乱动，免得把空层翻上来。
      engine.setVisible(true);
      engine.play();
      window.setTimeout(() => engine.syncRect(true), 60);
    }
    const v = feedRef.current?.querySelector<HTMLVideoElement>('.slide.active video');
    if (v && v.paused) v.play().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeKey]);

  // 播放页退出时把「看到第几集」写回首页这一屏（进度由播放器落库，这里只对齐集数）
  useEffect(() => {
    if (!epSync) return;
    const { vid, ep } = epSync;
    setEps((m) => (m[vid] === ep || ep < 1 ? m : { ...m, [vid]: ep }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epSync?.k]);

  const reload = () => {
    usedPages.current = new Set();
    resetPool();
    catalogRef.current = null;
    lastCate.current = undefined;
    setItems([]);
    setFailed(false);
    setEnd(false);
    loadMore();
  };

  useEffect(() => {
    if (!refreshKey) return;
    reload();
    setActive(0);
    setY(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // PC：滚轮 / 上下箭头切一屏（只有当前显示的频道响应）
  useEffect(() => {
    if (!on) return;
    const box = feedRef.current;
    if (!box) return;
    let lock = 0;
    const step = (dir: number) => {
      const now = Date.now();
      if (now - lock < 380) return;
      lock = now;
      const idx = Math.max(0, Math.min(items.length - 1, activeRef.current + dir));
      scrollTo(idx);
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      step(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        step(-1);
      }
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, items.length]);

  return (
    <>
      <div
        className="feed pager"
        ref={feedRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="feed-track" ref={trackRef}>
        {items.length === 0 && (
          <section className="slide" style={{ ['--i' as any]: 0 }}>
            <div className="feed-loading">
              {failed ? (
                <>
                  <div>加载失败</div>
                  <button type="button" className="btn-ghost" onClick={reload}>
                    点击重试
                  </button>
                </>
              ) : (
                '加载中…'
              )}
            </div>
          </section>
        )}

        {items.map((v, i) => (
          <FeedSlide
            key={`${v.id}-${i}`}
            v={v}
            index={i}
            idxStyle={{ ['--i' as any]: i }}
            // 原生只有一个播放器：非当前频道的那两屏不能抢，否则谁最后一 claim 谁出声
            active={on && i === active}
            desktop={isDesktop}
            muted={muted}
            ep={eps[v.id] || 1}
            quality={quality}
            onPickEpisode={(vv) => setPicker(vv)}
            onPickQuality={(q) => setQuality(q)}
            danmaku={danmakuOf(v.description, [MOCK_DANMAKU[i % MOCK_DANMAKU.length]])}
            onToggleMute={() => setMuted((m) => !m)}
            onOpen={onOpen}
            onDetail={onDetail}
            onComment={onComment}
            onShare={onShare}
            onLandscape={onLandscape}
            onToast={onToast}
            suspend={suspend}
            onAdvance={() => {
              if (i !== activeRef.current) return;
              // 这一部播完了：直接进播放页接着看下一集（没有下一集就停在最后一集）
              const epTotal = v.episode_count || v.total_episodes || 1;
              const curEp = eps[v.id] || 1;
              if (epTotal > 1) {
                onOpen(v, Math.min(epTotal, curEp + 1), 0);
                return;
              }
              scrollTo(i + 1);
            }}
            liked={isLiked(v.id)}
            onLike={() => {
              void toggleLike(v).then(() => bumpMarks());
            }}
            faved={isFav(v.id)}
            onFav={() => {
              void toggleFav(v).then(() => bumpMarks());
            }}
          />
        ))}

        <div className="feed-sentinel" ref={sentinelRef} style={{ ['--i' as any]: items.length }}>
          {end ? `已加载全部 ${total || items.length} 部` : '继续下滑，随机推荐…'}
        </div>
        </div>
      </div>

      {picker && (
        <EpisodePicker
          video={picker}
          current={eps[picker.id] || 1}
          onPick={(ep) => {
            setEps((m) => ({ ...m, [picker.id]: ep }));
            onToast(`正在播放第 ${ep} 集`);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
