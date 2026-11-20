import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import { loadMarks, marksSnapshot, subscribeMarks, toggleFav, toggleLike } from '../core/marks';
import type { Video } from '../data/types';
import { fmtProgress } from '../lib/format';
import { getHistory, getProgress, removeHistory, type FavItem } from '../core/store';
import { getToken, type User } from '../core/auth';
import { bindCollapseScroll } from '../core/collapseScroll';
import { Icon, type IconName } from '../components/Icons';

/** 上游没有消息/金币/预约接口，这几格就不摆入口，避免点进去是编造的假数据 */
const TABS = ['历史', '收藏', '追更', '点赞'] as const;
const FILTERS = ['全部', '已看完', '未看完'] as const;

/** 顶部压缩量：展开 → 收成一条 一共吃掉多少像素（手势位移换算比例）
 *  只覆盖「统计行 + 间隙」这一截，头像区不再动 */
const SPAN = 49;

type Card = {
  id: number;
  title: string;
  cover: string;
  ep?: number;
  total?: number;
};

export function ProfilePage({
  onOpen,
  onDetail,
  onSearch,
  onToggleTheme,
  theme,
  onDrawer,
  onToast,
  user,
  onLogin,
  onLogout,
  focusTab,
  onTabChange,
}: {
  onOpen: (v: Video, ep?: number) => void;
  onDetail: (id: number) => void;
  onSearch: () => void;
  onToggleTheme: () => void;
  theme: 'light' | 'dark';
  onDrawer: () => void;
  onToast: (t: string) => void;
  user: User | null;
  onLogin: () => void;
  onLogout: () => void;
  /** PC 侧栏直接点「收藏 / 历史 / 追更 / 点赞」时，落到对应标签 */
  focusTab?: (typeof TABS)[number];
  /** 页内切标签时回传，PC 侧栏的高亮跟着走 */
  onTabChange?: (t: (typeof TABS)[number]) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>(focusTab || '历史');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');
  const [edit, setEdit] = useState(false);
  const [hist, setHist] = useState<Card[]>([]);

  /** 收藏/点赞直接读全局那一份（首页/播放页/详情页点完，这里立刻跟着变） */
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);
  const snapMarks = marksSnapshot();

  // 历史只在本地，最多 30 条；进这一页先把账号那份收藏/点赞拉下来，再一起渲染
  const reload = useCallback(async () => {
    await loadMarks(true);
    setHist(
      getHistory().map((h) => {
        const p = getProgress(h.id);
        return {
          id: h.id,
          title: h.title,
          cover: h.cover,
          ep: p?.ep || h.ep,
          total: h.total,
        };
      }),
    );
    bumpMarks();
  }, []);

  useEffect(() => {
    if (focusTab) setTab(focusTab);
  }, [focusTab]);

  useEffect(() => {
    reload();
  }, [reload, tab]);

  const toCards = (items: FavItem[]): Card[] =>
    items.map((x) => {
      const p = getProgress(x.id);
      const h = getHistory().find((y) => y.id === x.id);
      return { id: x.id, title: x.title, cover: x.cover, ep: p?.ep || h?.ep, total: h?.total };
    });

  const favs: Card[] = toCards(snapMarks.favItems);
  const likes: Card[] = toCards(snapMarks.likeItems);

  const openCard = async (c: Card) => {
    if (edit) {
      void removeCard(c);
      return;
    }
    // 历史/收藏里只有 id/标题/封面：补一次详情，播放页才能拿到真实集数和简介；
    // 拉不到就退回这份够用的最小对象，绝不因此点不开。
    let v = {
      id: c.id,
      title: c.title,
      cover: c.cover,
      episode_count: c.total || 0,
      total_episodes: c.total || 0,
    } as Video;
    try {
      const d = await api.video(c.id);
      if (d && d.id) v = d;
    } catch {
      /* 详情失败就用最小对象 */
    }
    onOpen(v, c.ep || 0);
  };

  const removeCard = async (c: Card) => {
    if (tab === '历史') {
      removeHistory(c.id);
      onToast('已从历史里删掉');
      await reload();
      return;
    }
    // 收藏/点赞的删除就是「再点一次」，走同一份全局状态（登录时自动回写账号）
    await (tab === '点赞' ? toggleLike(c) : toggleFav(c));
    onToast('已移除');
    await reload();
  };

  // 追更 = 自己收藏了、但还没看完的那部分（用真实进度判断）
  const following: Card[] = favs.filter((c) => {
    const total = c.total || 0;
    const seen = c.ep || 0;
    return !(total > 0 && seen >= total);
  });

  const base: Card[] =
    tab === '历史' ? hist : tab === '收藏' ? favs : tab === '追更' ? following : likes;

  // 已看完 / 未看完：只用真实集数进度判断，没有进度的算未看完
  const source: Card[] =
    filter === '全部'
      ? base
      : base.filter((c) => {
          const total = c.total || 0;
          const seen = c.ep || 0;
          const done = total > 0 && seen >= total;
          return filter === '已看完' ? done : !done;
        });

  const pageRef = useRef<HTMLDivElement | null>(null);
  const pRef = useRef(0);
  const stuckRef = useRef(false);

  // 顶部先压缩（压缩期间内容相对顶栏不动），压缩吃满之后才滚内容
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const setP = (p: number) => {
      pRef.current = p;
      el.style.setProperty('--p', p.toFixed(3));
    };
    setP(0);
    const unbind = bindCollapseScroll(el, { span: SPAN, getP: () => pRef.current, setP });
    // 头部滚出状态栏这条带之后，用白底把 0~44 盖住（内容不许从状态栏区露出来）
    const onScroll = () => {
      const stuck = el.scrollTop > 56;
      if (stuck !== stuckRef.current) {
        stuckRef.current = stuck;
        el.classList.toggle('stuck', stuck);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      unbind();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  const stats = [
    { k: '收藏', v: favs.length },
    { k: '历史', v: hist.length },
    { k: '点赞', v: likes.length },
  ];

  const emptyText =
    !user
      ? tab === '历史'
        ? '还没有观看记录，去首页看一部吧'
        : `登录后才能同步${tab}`
      : filter === '全部'
        ? `还没有${tab === '追更' ? '在追的剧' : tab}记录`
        : `没有${filter}的记录`;

  return (
    <div ref={pageRef} className="mp-page">
      <div className="mp-head">
        <div className="mp-dots" />
        <div className="mp-acts">
          <button type="button" onClick={onToggleTheme} aria-label="夜间模式">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={22} strokeWidth={1.8} />
          </button>
          <button type="button" onClick={onDrawer} aria-label="菜单">
            <Icon name="menu" size={24} strokeWidth={2} />
          </button>
        </div>

        <div className="mp-user">
          <div className="mp-avatar" onClick={user ? undefined : onLogin}>
            {user?.avatar ? <img src={user.avatar} alt="" /> : user ? (user.nickname || 'U').slice(0, 1) : '🙂'}
          </div>
          <div className="mp-umid">
            {user ? (
              <>
                <div className="mp-nick">{user.nickname || user.username}</div>
                <div className="mp-stats">
                  {stats.map((s) => (
                    <span key={s.k}>
                      <b>{s.v}</b>
                      {s.k}
                    </span>
                  ))}
                  <button type="button" className="mp-logout" onClick={onLogout}>
                    退出
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mp-nick" onClick={onLogin}>
                  点击登录
                </div>
                <div className="mp-stats dim" onClick={onLogin}>
                  登录后同步收藏 · 点赞 · 历史
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mp-panel">
        {/* tabs + 筛选 + 「已播放超5秒」整块吸顶：块内没有缝，网格只能从它下面过 */}
        <div className="mp-fix">
          <div className="mp-tabs">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                className={t === tab ? 'on' : ''}
                onClick={() => {
                  setTab(t);
                  setEdit(false);
                  onTabChange?.(t);
                }}
              >
                {t}
              </button>
            ))}
            <span className="sp" />
            <button type="button" className="mp-search" onClick={onSearch} aria-label="搜索">
              <Icon name="search" size={20} strokeWidth={1.9} />
            </button>
          </div>

          <div className="mp-filter">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`fchip${f === filter ? ' on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
            <span className="fright">
              {base.length > 0 && (
                <span
                  className={edit ? 'on' : ''}
                  onClick={() => setEdit((e) => !e)}
                >
                  {edit ? '完成' : '编辑'}
                </span>
              )}
            </span>
          </div>

          <div className="mp-played">
            <Icon name="check" size={13} strokeWidth={2.4} />
            {user ? '已与账号同步' : '记录保存在本机'}
          </div>
        </div>

        <div className="mp-grid">
          {source.map((c) => (
            <div
              className={`mp-card${edit ? ' editing' : ''}`}
              key={`${tab}-${filter}-${c.id}`}
              onClick={() => openCard(c)}
            >
              <div className="mp-poster">
                <img src={coverUrl(c.cover)} alt={c.title} loading="eager" decoding="async" />
                {c.total ? <span className="mp-badge">全{c.total}集</span> : null}
                {edit && (
                  <span className="mp-del">
                    <Icon name="close" size={13} strokeWidth={2.4} />
                  </span>
                )}
              </div>
              <div
                className="mp-title"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!edit) onDetail(c.id);
                }}
              >
                {c.title}
              </div>
              <div className="mp-meta">
                {c.ep
                  ? fmtProgress(c.ep, c.total || c.ep)
                  : tab === '收藏'
                    ? '已收藏'
                    : tab === '点赞'
                      ? '已点赞'
                      : '看过'}
              </div>
            </div>
          ))}
          {source.length === 0 && (
            <div className="mp-empty">
              <span>{emptyText}</span>
              {!user && tab !== '历史' && (
                <button type="button" className="mp-login-btn" onClick={onLogin}>
                  去登录
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
