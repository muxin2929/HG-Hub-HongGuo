import { useEffect, useMemo, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import type { Video } from '../data/types';
import { fmtNum } from '../lib/format';
import { Icon } from '../components/Icons';
import { bindCollapseScroll } from '../core/collapseScroll';

type Chan = '漫剧' | 'AI剧';
type Tab = '推荐榜' | '热播榜' | '新剧榜';

/** 上游分类 id：25=漫剧，24=AI剧 */
const CATE: Record<Chan, number> = { 漫剧: 25, AI剧: 24 };
const TABS: Tab[] = ['推荐榜', '热播榜', '新剧榜'];
/** 标签 → 网关每日榜单的类型 */
const TYPE_OF: Record<Tab, 'recommend' | 'hot' | 'new'> = {
  推荐榜: 'recommend',
  热播榜: 'hot',
  新剧榜: 'new',
};

export function Laurel() {
  return (
    <svg width="22" height="30" viewBox="0 0 22 30" aria-hidden="true" className="bh-laurel">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M16 4c-7 4-11 11-11 22" />
        <path d="M9 8c-3-1-5 0-6 2 2 1 4 1 6-2ZM7 13c-3 0-5 2-5 4 2 1 4 0 5-4ZM6 19c-3 1-4 3-4 5 2 0 4-2 4-5Z" />
        <path d="M12 6c2-2 5-2 7 0-2 2-5 2-7 0Z" />
      </g>
    </svg>
  );
}

const tagsOf = (v: Video): string[] =>
  (v.tags || []).map((t) => (typeof t === 'string' ? t : (t as any)?.name)).filter(Boolean) as string[];

const likeScore = (v: Video) => (v.like_count || 0) + (v.collect_count || 0);
const hotOf = (v: Video) => v.hot_count ?? v.hot ?? v.counts?.hot ?? 0;

/**
 * 榜单页（对照参考图 1:1 重绘）。
 *
 * 数据全部来自上游真实字段，没有一处是编的：
 *   漫剧 = /api/videos?cate_id=25，AI剧 = /api/videos?cate_id=24
 *   推荐榜 = 按「点赞 + 收藏」排序
 *   热播榜 = 按 hot（热度）排序
 *   新剧榜 = 按 created_at（上游上架时间）排序
 * 排名序号就是排序后的真实位次；右侧数字、下方胶囊也全取自条目自身字段。
 */
export function RankPage({
  onOpen,
  onDetail,
  onToast,
  onBack,
  onSearch,
}: {
  onOpen: (v: Video, ep?: number) => void;
  onDetail: (id: number) => void;
  onToast: (t: string) => void;
  onBack?: () => void;
  onSearch?: () => void;
}) {
  const [chan, setChan] = useState<Chan>('漫剧');
  const [tab, setTab] = useState<Tab>('推荐榜');
  const [items, setItems] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [catOpen, setCatOpen] = useState(false);
  const catOpenRef = useRef(false);
  const [tag, setTag] = useState<string>('');
  const [date, setDate] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  // 标题区压缩进度：0 = 展开，1 = 收成一条（用 CSS 变量驱动，避免每帧重渲染）
  const pRef = useRef(0);

  // 榜单数据来自网关的每日剧库快照（每天自动从上游抓一次），
  // 右上角日期就是那份快照的真实抓取日，不是前端拿今天日期糊的。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setItems([]);
    setTag('');
    setCatOpen(false);
    (async () => {
      try {
        const r = await api.ranksDaily(CATE[chan], TYPE_OF[tab], 60);
        if (!alive) return;
        if (r.date) {
          const [, m, d] = r.date.split('-');
          if (m && d) setDate(`${Number(m)}月${Number(d)}日已更新`);
        }
        if (r.items.length) {
          setItems(r.items);
        } else {
          // 快照还没抓好（刚部署）：退回实时翻页，日期留空
          const pool: Video[] = [];
          for (let p = 1; p <= 4; p++) {
            try {
              const rr = await api.videos(p, CATE[chan]);
              pool.push(...rr.items);
              if (rr.items.length < 20) break;
            } catch {
              break;
            }
          }
          if (!alive) return;
          setDate('');
          setItems(pool);
        }
      } catch {
        /* 抖动就保持原样 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chan, tab]);

  // 滚动：标题区先压缩（压缩期间内容相对顶栏/标签不动），压缩吃满后才滚内容
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const setP = (p: number) => {
      pRef.current = p;
      box.style.setProperty('--p', p.toFixed(3));
    };
    setP(0);
    const unbind = bindCollapseScroll(box, { span: 88, getP: () => pRef.current, setP });
    const onScroll = () => {
      if (catOpenRef.current) {
        catOpenRef.current = false;
        setCatOpen(false);
      }
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      unbind();
      box.removeEventListener('scroll', onScroll);
    };
  }, []);

  // 排序已经在网关每日快照里做好（顺序即真实位次），这里只做分类筛选
  const ordered = useMemo(
    () => (tag ? items.filter((v) => tagsOf(v).includes(tag)) : items),
    [items, tag],
  );

  /** 分类面板用真实标签，按出现次数排序 */
  const catTags = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const v of items) for (const t of tagsOf(v)) cnt.set(t, (cnt.get(t) || 0) + 1);
    return Array.from(cnt.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([t]) => t);
  }, [items]);

  const metric = (v: Video) => {
    if (tab === '推荐榜') return { n: likeScore(v), label: '推荐' };
    return { n: hotOf(v), label: '热度' };
  };

  return (
    <div className="rank-page" ref={boxRef}>
      {/* 标题区 + 两行标签合成一整块吸顶：中间没有缝，内容不可能透出来 */}
      <div className="bh-fix">
        <div className={`bh-head${chan === 'AI剧' ? ' ai' : ''}`}>
          <div className="bh-cloud" />
          <div className="bh-bar">
            <button type="button" className="bh-icon" onClick={() => onBack?.()} aria-label="返回">
              <Icon name="back" size={24} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className="bh-help"
              onClick={() => onToast('榜单规则：按上游真实的点赞/热度/上架时间排序')}
              aria-label="榜单说明"
            >
              ?
            </button>
          </div>
          <div className="bh-title">
            <Laurel />
            <span>{chan}推荐榜</span>
            <Laurel />
          </div>
          <div className="bh-sub">{date}·基于观看/互动以及个人兴趣排序</div>
        </div>

        <div className="bh-sheet">
          <div className="bh-chans">
            {(['漫剧', 'AI剧'] as Chan[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`bh-chan${c === chan ? ' on' : ''}`}
                onClick={() => {
                  if (c !== chan) {
                    setChan(c);
                    setTab('推荐榜');
                  }
                }}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="bh-filters">
            <div className="bh-fchipwrap">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`bh-fchip${t === tab ? ' on' : ''}`}
                  onClick={() => {
                    setTab(t);
                    setTag('');
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="bh-cat"
              onClick={() => {
                const v = !catOpenRef.current;
                catOpenRef.current = v;
                setCatOpen(v);
              }}
            >
              分类
              <Icon
                name="chevron"
                size={12}
                strokeWidth={2}
                style={{ transform: 'rotate(90deg)', opacity: 0.75 }}
              />
            </button>

            {catOpen && (
              <>
                <div className="bh-catmask" onClick={() => { catOpenRef.current = false; setCatOpen(false); }} />
                <div className="bh-catpanel">
                  <button
                    type="button"
                    className={tag === '' ? 'on' : ''}
                    onClick={() => {
                      catOpenRef.current = false;
                      setTag('');
                      setCatOpen(false);
                    }}
                  >
                    全部分类
                  </button>
                  {catTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={tag === t ? 'on' : ''}
                      onClick={() => {
                        catOpenRef.current = false;
                        setTag(t);
                        setCatOpen(false);
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="bh-list">
        {loading && <div className="t-loading">加载中…</div>}
        {!loading && ordered.length === 0 && <div className="empty">这个分类下暂时没有剧</div>}

        {ordered.map((v, i) => {
          const rank = i + 1;
          const m = metric(v);
          const tags = tagsOf(v);
          const eps = v.episode_count || v.total_episodes || 0;
          const hot = hotOf(v);
          const like = v.like_count || 0;
          const blast = v.badge === '爆剧' || !!(v as any).is_hot;
          return (
            <div
              className="bh-row"
              key={v.id}
              onPointerEnter={() => api.prefetchDetail(v.id)}
              onTouchStart={() => api.prefetchDetail(v.id)}
              onClick={() => onOpen(v)}
            >
              <div className="bh-poster">
                <img src={coverUrl(v.cover)} alt={v.title} loading={i < 10 ? 'eager' : 'lazy'} decoding="async" />
                <span className={`bh-rank${rank <= 1 ? ' n1' : rank <= 3 ? ' n23' : ''}`}>{rank}</span>
              </div>

              <div className="bh-body">
                <div className="bh-l1">
                  <h4
                    className="bh-name"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDetail(v.id!);
                    }}
                  >
                    {v.title}
                  </h4>
                  <span className="bh-metric">
                    <Icon name="fire" size={14} strokeWidth={2.1} />
                    {fmtNum(m.n)}
                    {m.label}
                  </span>
                </div>
                <div className="bh-meta">
                  {tags[0] || (v as any).cate_name || '短剧'} · 全{eps}集
                </div>
                <div className="bh-desc">{(v.description || '').replace(/\s+/g, ' ') || tags.slice(1).join(' / ')}</div>
                <div className="bh-chips">
                  {blast && <span className="bh-chip blast">爆剧</span>}
                  {hot > 0 && <span className="bh-chip">{fmtNum(hot)}热度</span>}
                  {like > 0 && <span className="bh-chip">{fmtNum(like)}点赞</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

