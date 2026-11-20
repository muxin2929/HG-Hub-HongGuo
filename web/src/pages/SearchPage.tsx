import { useCallback, useEffect, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import type { Video } from '../data/types';
import { fmtHeat } from '../lib/format';
import { Icon } from '../components/Icons';
import { Laurel } from './RankPage';
import {
  clearSearchHistory,
  getSearchHistory,
  pushSearchHistory,
} from '../core/store';

/** 搜索结果：双列 + 上拉加载（这一块沿用旧版，不动）。 */
export function SearchPage({
  initialQuery = '',
  onBack,
  onOpen,
  onDetail,
  onToast,
}: {
  initialQuery?: string;
  onBack: () => void;
  onOpen: (v: Video, ep?: number) => void;
  onDetail: (id: number) => void;
  onToast: (t: string) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [items, setItems] = useState<Video[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [hots, setHots] = useState<Array<{ word: string; heat: number }>>([]);
  const [hist, setHist] = useState<string[]>([]);
  const [rank, setRank] = useState<Video[]>([]);
  const loadingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHist(getSearchHistory());
    api.hotWords().then(setHots).catch(() => undefined);
    // 推荐榜：只要前 6 部（两行），数据就是上游 /api/ranks/recommend 的真实名次
    api
      .rank('recommend')
      .then((list) => setRank(list.slice(0, 6)))
      .catch(() => undefined);
    if (!initialQuery) inputRef.current?.focus();
  }, [initialQuery]);

  const search = useCallback(
    async (word: string, nextPage = 1) => {
      const keyword = word.trim();
      if (!keyword || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const p = await api.search(keyword, nextPage);
        setItems((prev) => (nextPage === 1 ? p.items : [...prev, ...p.items]));
        setPage(p.pagination.page);
        setPages(p.pagination.pages);
        setTotal(p.pagination.total);
        setSearched(true);
        if (nextPage === 1) {
          setHist(pushSearchHistory(keyword));
          listRef.current?.scrollTo({ top: 0 });
        }
      } catch {
        onToast('搜索失败，请重试');
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [onToast],
  );

  useEffect(() => {
    if (initialQuery) search(initialQuery, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || page >= pages) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) search(q, page + 1);
  };

  return (
    <div className="searchpage">
      <div className="sp-head">
        <button type="button" className="sp-back" onClick={onBack} aria-label="返回">
          <Icon name="back" size={24} strokeWidth={2} />
        </button>
        <div className="sp-box">
          <Icon name="search" size={18} strokeWidth={2} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search(q, 1)}
            placeholder="我的同桌兰呦呦：林与呦呦…"
            enterKeyHint="search"
          />
          {!!q && (
            <button type="button" className="sp-clear" onClick={() => setQ('')}>
              <Icon name="close" size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <button type="button" className="sp-go" onClick={() => search(q, 1)}>
          搜索
        </button>
      </div>

      <div className="sp-body" ref={listRef} onScroll={onScroll}>
        {!searched && (
          <div className="sp-land">
            {hist.length > 0 && (
              <section className="sp-sec">
                <div className="sp-sec-head">
                  <h2>搜索历史</h2>
                  <button
                    type="button"
                    className="sp-sec-act"
                    aria-label="清空搜索历史"
                    onClick={() => {
                      setHist(clearSearchHistory());
                      onToast('已清空搜索历史');
                    }}
                  >
                    <Icon name="trash" size={20} strokeWidth={1.7} />
                  </button>
                </div>
                <div className="sp-hist">
                  {hist.slice(0, 6).map((w) => (
                    <button
                      type="button"
                      key={w}
                      className="sp-hist-item"
                      onClick={() => {
                        setQ(w);
                        search(w, 1);
                      }}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="sp-sec">
              <div className="sp-sec-head">
                <h2>大家都在搜</h2>
              </div>
              <div className="sp-hots">
                {hots.map((h, i) => (
                  <button
                    type="button"
                    key={h.word}
                    className="sp-hot"
                    onClick={() => {
                      setQ(h.word);
                      search(h.word, 1);
                    }}
                  >
                    <span className={`sp-rank${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                    {h.word}
                  </button>
                ))}
                {hots.length === 0 && <span className="hint">暂无热搜</span>}
              </div>
            </section>

            {rank.length > 0 && (
              <section className="sp-rankbox">
                <div className="sp-rank-title">
                  <Laurel />
                  <span>推荐榜</span>
                  <span className="sp-flip">
                    <Laurel />
                  </span>
                </div>
                <div className="sp-rank-grid">
                  {rank.map((v, i) => {
                    const n = v.rank || i + 1;
                    const heat = v.counts?.hot ?? v.hot ?? v.hot_count ?? 0;
                    const tag =
                      (v.tags || [])
                        .map((t) => (typeof t === 'string' ? t : t?.name))
                        .filter(Boolean)[0] || '';
                    // 副标题：真实标签取前两个（参考图是「剧情·都市」这种写法）
                    const meta =
                      (v.tags || [])
                        .map((t) => (typeof t === 'string' ? t : t?.name))
                        .filter(Boolean)
                        .slice(0, 2)
                        .join('·') ||
                      (v as any).cate_name ||
                      '短剧';                    return (
                      <div
                        className="sp-rcard"
                        key={v.id}
                        onClick={() => onOpen(v)}
                      >
                        <div className="sp-rposter">
                          <img src={coverUrl(v.cover)} alt={v.title} />
                          <span className={`sp-rmark m${n <= 3 ? n : 'x'}`}>{n}</span>
                          {heat > 0 && (
                            <span className="sp-rheat">
                              <Icon name="flame" size={12} strokeWidth={1.8} />
                              {fmtHeat(heat)}
                            </span>
                          )}
                        </div>
                        <div className="sp-rtitle">{v.title}</div>
                        <div className="sp-rmeta">{meta}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}

        {searched && (
          <>
            <div className="sp-total">
              找到 <b>{total}</b> 部相关短剧
            </div>
            <div className="grid2" style={{ padding: 0 }}>
              {items.map((v, i) => (
                <div className="card" key={v.id} onClick={() => onOpen(v)}>
                  <div className="poster">
                    <img src={coverUrl(v.cover)} alt={v.title} loading={i < 10 ? 'eager' : 'lazy'} decoding="async" />
                    <span className="heatline">💧 {fmtHeat(v.hot_count)}</span>
                  </div>
                  <div
                    className="cardtitle"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDetail(v.id);
                    }}
                  >
                    {v.title}
                  </div>
                  <div className="cardtags">
                    {(v.tags || []).slice(0, 2).map((t) => (
                      <span className="ctag" key={String(t)}>
                        {typeof t === 'string' ? t : t?.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {loading && <div className="c-loading">搜索中…</div>}
            {!loading && items.length === 0 && (
              <div className="empty">没有找到「{q}」，换个词试试</div>
            )}
            {!loading && page >= pages && items.length > 0 && (
              <div className="c-loading">— 已加载全部 {total} 部 —</div>
            )}
            {items.length > 0 && page >= pages && (
              <button type="button" className="sp-playfirst" onClick={() => onOpen(items[0], 1)}>
                <Icon name="play" size={16} strokeWidth={2} />
                直接播放第一个结果
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
