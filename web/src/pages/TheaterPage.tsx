import { useEffect, useMemo, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import { warmCovers } from '../data/covers';
import type { Video } from '../data/types';
import { fmtHeat } from '../lib/format';
import { Icon } from '../components/Icons';
import { FilterSheet, SORT_LABEL, type SortKey } from '../components/FilterSheet';

/**
 * 剧场页。
 * 版式对照参考图：顶部「搜索框 + 三个按钮」整块固定（内容从固定栏下沿开始滚，绝不透出），
 * 下面双列卡片：封面（左上角编号 / 右上角集数 / 左下角热度）+ 标题两行 + 标签行。
 * 数据全部走真实接口（筛选 / 排序 / 分页）。
 */
export function TheaterPage({
  initialSort = 'default',
  onOpen,
  onDetail,
  onSearch,
  onRank,
  onToast,
}: {
  initialSort?: SortKey;
  onOpen: (v: Video, ep?: number) => void;
  onDetail: (id: number) => void;
  onSearch: () => void;
  onRank?: () => void;
  onToast: (t: string) => void;
}) {
  const [items, setItems] = useState<Video[]>([]);
  const [cate, setCate] = useState('');
  const [sort, setSort] = useState<SortKey>(initialSort);
  const [sheet, setSheet] = useState<'filter' | 'sort' | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  // 这一批到底加载完了没有：用来区分「还在转圈」和「上游真的没有内容」
  const [done, setDone] = useState(false);
  const [hot, setHot] = useState('');
  /** 新剧模式下「最新一集/一部是什么时候上的」，用真实 created_at */
  const [freshAt, setFreshAt] = useState('');
  const loadingRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const isNew = initialSort === 'new';

  /** 2026-11-19 16:07:37 → 今天 16:07 / 昨天 / 11-17 */
  const freshLabel = (t?: string) => {
    if (!t) return '';
    const s = t.slice(0, 10);
    const today = new Date();
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (s === ymd(today)) return `今天 ${t.slice(11, 16)}`;
    const y = new Date(today.getTime() - 86400000);
    if (s === ymd(y)) return '昨天';
    return s.slice(5);
  };

  /** 上架时间戳（上游三种写法都认）：created_at 字符串 / new_at / last_ep_at（秒） */
  const tsOf = (v: any): number => {
    const c = v?.created_at as string | undefined;
    if (c) {
      const t = Date.parse(c.replace(/-/g, '/'));
      if (!Number.isNaN(t)) return t;
    }
    const n = v?.new_at ?? v?.last_ep_at;
    if (typeof n === 'number' && n > 0) return n > 1e12 ? n : n * 1000;
    return 0;
  };
  /** 统一成 "YYYY-MM-DD HH:mm"，给 freshLabel 和角标用 */
  const stampOf = (v: any): string => {
    if (v?.created_at) return v.created_at as string;
    const t = tsOf(v);
    if (!t) return '';
    const d = new Date(t);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };

  // 搜索框占位用真实热搜词（参考图里也是一句热搜，不带前缀）
  useEffect(() => {
    api
      .hotWords()
      .then((list) => list[0]?.word && setHot(list[0].word))
      .catch(() => undefined);
  }, []);

  const load = async (nextPage: number, reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const upstreamSort = sort === 'new' ? 'new' : sort === 'hot' ? 'hot' : undefined;
      let p = await api.videos(nextPage, cate || undefined, upstreamSort as any);
      // 综合排序时随机取一页，避免每次进来都是同一批
      if (reset && sort === 'default' && p.pagination.pages > 1) {
        const rp = 1 + Math.floor(Math.random() * p.pagination.pages);
        p = await api.videos(rp, cate || undefined, undefined);
      }
      const list =
        sort === 'episodes'
          ? [...p.items].sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0))
          : sort === 'new'
            // 上游 sort=new 不一定按上架时间给，这里本地按真实时间再排一遍，保证「新剧」是真最新
            ? [...p.items].sort((a, b) => tsOf(b) - tsOf(a))
            : p.items;
      // 封面并行预热：列表一出来就开始下载，不用等滚动到视野
      warmCovers(list, 12);
      if (reset && sort === 'new' && list[0]) setFreshAt(freshLabel(stampOf(list[0])));
      setItems((prev) => (reset ? list : [...prev, ...list]));
      setPage(p.pagination.page);
      setPages(p.pagination.pages);
    } catch {
      onToast('加载失败，请重试');
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (reset) setDone(true);
    }
  };

  useEffect(() => {
    setItems([]);
    setDone(false);
    load(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cate, sort]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      if (
        el.scrollTop + el.clientHeight > el.scrollHeight - el.clientHeight * 1.5 &&
        page < pages &&
        !loading
      ) {
        load(page + 1);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, loading, cate, sort]);

  /** 列数：手机 2 列；平板 3 列；PC 4 列 */
  const [ncol, setNcol] = useState(() => {
    const w = typeof window === 'undefined' ? 400 : window.innerWidth;
    return w >= 1100 ? 4 : w >= 760 ? 3 : 2;
  });
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      setNcol(w >= 1100 ? 4 : w >= 760 ? 3 : 2);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * 瀑布流：按「预估高度」把每张卡塞进当前最短的那一列。
   * 估算只用来决定进哪列，不改任何显示尺寸；而且是纯函数，
   * 列表往后追加时已有卡片不会跳位。
   */
  const cols = useMemo(() => {
    const buckets: Video[][] = Array.from({ length: ncol }, () => []);
    const heights = new Array(ncol).fill(0);
    for (const v of items) {
      const len = (v.title || '').length;
      const lines = Math.max(1, Math.min(2, Math.ceil(len / 11)));
      // 以卡片宽度 1000 为单位：封面 3:4 = 1333，标题 9 + 行数×22.4，标签 8 + 27
      const h = 1333 + 8 + lines * 21 + 8 + 26;
      let k = 0;
      for (let i = 1; i < ncol; i++) if (heights[i] < heights[k]) k = i;
      buckets[k].push(v);
      heights[k] += h;
    }
    return buckets;
  }, [items, ncol]);

  return (
    <div className="page theater-page" ref={boxRef as any}>
      {/* 固定栏：搜索 + 三按钮。自身从 0 起铺实色底，44px 以下才开始放组件 */}
      <div className="theater-head">
        {isNew && (
          <div className="tnew-head">
            <b>每日上新</b>
            <span>{freshAt ? `最新更新 ${freshAt}` : '按上架时间排序'}</span>
          </div>
        )}
        <div className="tsearch" onClick={onSearch}>
          <Icon name="search" size={20} strokeWidth={2} />
          <span className="q">{hot || '搜剧名、作者、标签'}</span>
        </div>

        <div className="tquick">
          <button
            type="button"
            className="tq tq-filter"
            onClick={() => setSheet('filter')}
          >
            <Icon name="funnel" size={20} strokeWidth={2} />
            <span>{cate ? '已筛选' : '筛选'}</span>
          </button>
          <button type="button" className="tq tq-rank" onClick={() => onRank?.()}>
            <Icon name="flame" size={20} strokeWidth={2} />
            <span>榜单</span>
          </button>
          <button
            type="button"
            className="tq tq-book"
            onClick={() => onToast('预约功能开发中')}
          >
            <Icon name="calendar" size={20} strokeWidth={2} />
            <span>预约</span>
          </button>
        </div>
      </div>

      {/* 瀑布流：两列各自独立堆叠。
          封面 3:4（上游原图就是这个比例，不裁），剧名一行的卡片天然比两行的短，
          下一张就往上贴 —— 不做行对齐。 */}
      <div className="tmasonry">
        {items.length === 0 && !done
          ? cols.map((_, ci) => (
              <div className="tcol" key={ci}>
                {Array.from({ length: 3 }, (_, i) => (
                  <div className="tcard" key={i}>
                    <div className="tcover skel" />
                    <div className="skel" style={{ height: 16, marginTop: 8, width: '82%' }} />
                  </div>
                ))}
              </div>
            ))
          : cols.map((col, ci) => (
              <div className="tcol" key={ci}>
                {col.map((v, i) => {
                  const tags = (v.tags || [])
                    .slice(0, 3)
                    .map((t) => (typeof t === 'string' ? t : (t as any)?.name))
                    .filter(Boolean) as string[];
                  return (
                    <div
                      className="tcard"
                      key={v.id}
                      onPointerEnter={() => api.prefetchDetail(v.id)}
                      onTouchStart={() => api.prefetchDetail(v.id)}
                      onClick={() => onOpen(v)}
                    >
                      <div className="tcover">
                        <img
                          src={coverUrl(v.cover)}
                          alt={v.title}
                          loading={ci === 0 && i < 10 ? 'eager' : 'lazy'} decoding="async"
                        />
                        {v.badge && (
                          <span className={`tbadge${v.badge === '爆剧' ? ' hot' : ''}`}>{v.badge}</span>
                        )}
                        <span className="theat">
                          <Icon name="fire" size={12} strokeWidth={1.9} />
                          {fmtHeat(v.hot_count ?? v.counts?.hot)}
                        </span>
                        {sort === 'new' && stampOf(v) && (
                          <span className="tnew-at">{freshLabel(stampOf(v))}</span>
                        )}
                      </div>
                      <div
                        className="ttitle"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDetail(v.id);
                        }}
                      >
                        {v.title}
                      </div>
                      {tags.length > 0 && (
                        <div className="ttags">
                          {tags.map((t) => (
                            <span className="ttag" key={t}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
      </div>

      {loading && <div className="t-loading">加载中…</div>}

      {/* 上游这个分类确实一条都没有：明确告诉用户，别让人以为卡住了 */}
      {done && !loading && items.length === 0 && (
        <div className="t-empty">
          <Icon name="theater" size={40} strokeWidth={1.4} />
          <p>这个分类下暂时还没有内容</p>
          <button type="button" onClick={() => setCate('')}>
            看全部
          </button>
        </div>
      )}

      {sheet && (
        <FilterSheet
          cate={cate}
          sort={sort}
          focus={sheet}
          onApply={(c, s) => {
            setCate(c);
            setSort(s);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
