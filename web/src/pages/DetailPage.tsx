import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, coverUrl } from '../data/api';
import type { Video } from '../data/types';
import { fmtHeat } from '../lib/format';
import { getProgress, addHistory } from '../core/store';
import { isFav, loadMarks, subscribeMarks, toggleFav } from '../core/marks';
import { auth, getToken } from '../core/auth';
import { Icon } from '../components/Icons';

const RANGE = 30;
/** 每部剧详情页上次滚到哪儿：从播放页回来要落回原处，别又从头看一遍 */
const SCROLL = new Map<number, number>();
const TABS = ['基本信息', '选集', '猜你喜欢'] as const;


export function DetailPage({
  id,
  onBack,
  onPlay,
  onShare,
  onToast,
}: {
  id: number;
  onBack: () => void;
  onPlay: (v: Video, ep: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onToast: (t: string) => void;
}) {
  const [v, setV] = useState<Video | null>(null);
  const [related, setRelated] = useState<Video[]>([]);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [range, setRange] = useState(0);
  // 收藏和首页/播放页/我的页共用一份全局状态（账号优先）
  const [, bumpMarks] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeMarks(() => bumpMarks()), []);
  const [tab, setTab] = useState<(typeof TABS)[number]>('基本信息');
  const [scrolled, setScrolled] = useState(false);
  // 背景色跟着封面走（跟参考图一样，每个剧的底色由海报晕出来的深色）
  const [c1, setC1] = useState('#5a2d24');
  const [c2, setC2] = useState('#6a392b');

  const pageRef = useRef<HTMLDivElement | null>(null);
  const basicRef = useRef<HTMLDivElement | null>(null);
  const epsRef = useRef<HTMLDivElement | null>(null);
  const likeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setV(null);
    setErr('');
    setExpanded(false);
    setRange(0);
    setTab('基本信息');
    api
      .video(id)
      .then((d) => {
        if (!alive) return;
        setV(d);
        // 收藏状态不在这一页自己算：全局那份已经按账号/本地拉好了
        void loadMarks();
        const saved = getProgress(d.id);
        addHistory(d, saved?.ep || 1);
        // 有历史就落到历史所在的那一组区间，参考图里高亮格子和当前集是一致的
        setRange(Math.max(0, Math.floor(((saved?.ep || 1) - 1) / RANGE)));
      })
      .catch((e) => alive && setErr(String(e?.message || e)));
    api
      .related(id)
      .then((list) => alive && setRelated(list.filter((x) => x.id !== id).slice(0, 8)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  // 滚过头部之后：顶栏浮出剧名，标签行的选中项跟着滚动位置走
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const onScroll = () => {
      const y = el.scrollTop;
      SCROLL.set(id, y);
      setScrolled(y > 48);
      // 以「标签行吸顶后的下沿」为准：板块的上沿顶到这条线，才算切到这个板块
      const tabsEl = el.querySelector('.dp-tabs');
      const line = (tabsEl ? tabsEl.getBoundingClientRect().bottom : 94) + 8;
      const topOf = (r: React.RefObject<HTMLDivElement | null>) =>
        r.current ? r.current.getBoundingClientRect().top : Infinity;
      setTab(topOf(likeRef) <= line ? '猜你喜欢' : topOf(epsRef) <= line ? '选集' : '基本信息');
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // 从播放页/别处回来时落在原位置，不从顶上重新看一遍
    const back = SCROLL.get(id) || 0;
    if (back > 0) el.scrollTop = back;
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [v, id]);

  // 底部/顶栏底色跟着封面走：把封面缩到 12×12 取个平均色，再压暗两档
  useEffect(() => {
    const cover = v?.cover;
    if (!cover) return;
    let alive = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!alive) return;
      try {
        const n = 12;
        const cv = document.createElement('canvas');
        cv.width = n;
        cv.height = n;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, n, n);
        const px = ctx.getImageData(0, 0, n, n).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < px.length; i += 4) {
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
        const cnt = px.length / 4;
        r = r / (cnt * 255);
        g = g / (cnt * 255);
        b = b / (cnt * 255);
        // 转 HSL 再压暗：平均色直接乘系数会发灰发脏，先把饱和度拉到参考图那种浓度
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        let h = 0;
        const l = (mx + mn) / 2;
        const d = mx - mn;
        let s = 0;
        if (d > 0) {
          s = d / (1 - Math.abs(2 * l - 1) || 1);
          if (mx === r) h = ((g - b) / d) % 6;
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
        }
        // 灰/黑白海报取到的色相不可靠，统一退回偏暖的红棕
        if (s < 0.16) {
          h = 14;
          s = 0.34;
        } else {
          s = Math.min(0.6, Math.max(0.3, s * 1.1));
        }
        // 色相只在暖红棕区间里轻微摆动：参考图整体都是深棕红，蓝紫海报也不能变成藏青
        const diff = (((h - 14 + 540) % 360) - 180);
        h = 14 + (diff / 180) * 12;
        const hsl = (hh: number, ss: number, ll: number) =>
          `hsl(${Math.round(hh)}, ${Math.round(ss * 100)}%, ${Math.round(ll * 100)}%)`;
        setC1(hsl(h, s, 0.2));
        setC2(hsl(h, s * 0.94, 0.27));
      } catch {
        /* 取不到颜色就退回默认底色 */
      }
    };
    img.src = coverUrl(cover);
    return () => {
      alive = false;
    };
  }, [v?.cover]);

  const total = v?.episode_count || v?.total_episodes || v?.episodes?.length || 0;
  const prog = v ? getProgress(v.id) : null;
  // 当前集：有进度就按进度，没有就按第1集（选集里高亮的那一格，跟参考图一样）
  const curEp = prog?.ep || (total ? 1 : 0);
  const heat = v?.counts?.hot ?? v?.hot ?? v?.hot_count ?? 0;
  const ranges = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (let s = 1; s <= total; s += RANGE) out.push([s, Math.min(total, s + RANGE - 1)]);
    return out;
  }, [total]);

  const curRange = ranges[range] || [1, Math.min(total, RANGE)];
  const eps = useMemo(() => {
    if (!v) return [];
    const list = (v.episodes || []).map((e) => e.ep_num);
    const all = list.length ? list : Array.from({ length: total }, (_, i) => i + 1);
    return all.filter((n) => n >= curRange[0] && n <= curRange[1]);
  }, [v, curRange, total]);

  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>, name: (typeof TABS)[number]) => {
    setTab(name);
    const el = pageRef.current;
    const sec = ref.current;
    if (!el || !sec) return;
    const tabsEl = el.querySelector('.dp-tabs');
    const line = tabsEl ? tabsEl.getBoundingClientRect().bottom : 94;
    // 让板块上沿停在吸顶标签行下面 8px，按当前位置的差值滚，避免跟 offsetTop 的参照系打架
    const delta = sec.getBoundingClientRect().top - line - 8;
    el.scrollTo({ top: Math.max(0, el.scrollTop + delta), behavior: 'smooth' });
  };

  if (!v && !err) {
    return (
      <div className="dp-page">
        <div className="dp-top">
          <button type="button" className="dp-ic" onClick={onBack} aria-label="返回">
            <Icon name="back" size={24} strokeWidth={2} />
          </button>
        </div>
        <div className="dp-skeleton">
          <div className="dp-sk-cover" />
          <div className="dp-sk-lines">
            <div className="dp-sk" style={{ width: '62%', height: 22 }} />
            <div className="dp-sk" style={{ width: '38%' }} />
            <div className="dp-sk" style={{ width: '52%' }} />
          </div>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="dp-page">
        <div className="dp-top">
          <button type="button" className="dp-ic" onClick={onBack} aria-label="返回">
            <Icon name="back" size={24} strokeWidth={2} />
          </button>
        </div>
        <div className="dp-err">加载失败：{err}</div>
      </div>
    );
  }

  return (
    <div
      ref={pageRef}
      className="dp-page"
      style={{ '--dp-c1': c1, '--dp-c2': c2 } as React.CSSProperties}
    >
      <div className="dp-top">
        <button type="button" className="dp-ic" onClick={onBack} aria-label="返回">
          <Icon name="back" size={24} strokeWidth={2} />
        </button>
        <div className={`dp-top-title${scrolled ? ' on' : ''}`}>{v?.title}</div>
        <div className="dp-top-right">
          <button
            type="button"
            className="dp-ic"
            onClick={() => v && onShare(v, prog?.ep || 1)}
            aria-label="分享"
          >
            <Icon name="expand" size={20} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="dp-ic"
            onClick={() => onToast('更多：举报 / 反馈 / 不感兴趣')}
            aria-label="更多"
          >
            <Icon name="more" size={20} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="dp-hero">
        <div className="dp-cover">
          <img src={coverUrl(v?.cover)} alt={v?.title || ''} />
        </div>
        <div className="dp-meta">
          <h1>{v?.title || '加载中…'}</h1>
          <div className="dp-sub">
            全{total}集{heat > 0 ? ` · ${fmtHeat(heat)}` : ''}
          </div>
          <div className="dp-chips">
            {!!v?.score && (
              <span className="dp-score">
                <Icon name="star" size={14} strokeWidth={1.6} />
                {v.score}分
              </span>
            )}
            {(v?.tags || []).slice(0, 2).map((t) => {
              const name = typeof t === 'string' ? t : t?.name;
              if (!name) return null;
              return (
                <button
                  type="button"
                  className="dp-chip"
                  key={name}
                  onClick={() => onToast(`分类：${name}`)}
                >
                  {name}
                  <Icon name="chevron" size={12} strokeWidth={2.4} />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="dp-hr" />

      {/* 标签行：滚上去之后吸在顶栏下面，整行是页面底色，内容只能从它下面过 */}
      <div className="dp-tabs">
        {TABS.map((t, i) => (
          <button
            type="button"
            key={t}
            className={t === tab ? 'on' : ''}
            onClick={() =>
              scrollTo(i === 0 ? basicRef : i === 1 ? epsRef : likeRef, t)
            }
          >
            {t}
          </button>
        ))}
      </div>

      <div className="dp-body">
        <div className="dp-sec" ref={basicRef}>
          <div className={`dp-desc${expanded ? ' open' : ''}`}>{v?.description || '暂无简介'}</div>
          {!!v?.description && v.description.length > 60 && (
            <button type="button" className="dp-expand" onClick={() => setExpanded((x) => !x)}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>

        <div className="dp-sec" ref={epsRef}>
          <div className="dp-sec-head">
            <h3>选集</h3>
            <span>
              {v?.is_finished ? '已完结' : '连载中'} 共{total}集
              <Icon name="chevron" size={13} strokeWidth={2} />
            </span>
          </div>

          {ranges.length > 1 && (
            <div className="dp-ranges">
              {ranges.map(([a, b], i) => (
                <button
                  type="button"
                  key={a}
                  className={i === range ? 'on' : ''}
                  onClick={() => setRange(i)}
                >
                  {a}-{b}
                </button>
              ))}
            </div>
          )}

          <div className="dp-eps">
            {eps.map((n) => (
              <button
                type="button"
                key={n}
                className={`dp-ep${curEp === n ? ' on' : ''}`}
                onClick={() => v && onPlay(v, n)}
              >
                {curEp === n && (
                  <span className="dp-wave">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
                <span className="dp-ep-n">{n}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="dp-sec" ref={likeRef}>
          <div className="dp-sec-head">
            <h3>猜你喜欢</h3>
          </div>
          <div className="dp-guess">
            {related.map((r) => {
              const rh = r.counts?.hot ?? r.hot ?? r.hot_count ?? 0;
              const tags = (r.tags || [])
                .map((t) => (typeof t === 'string' ? t : t?.name))
                .filter(Boolean)
                .slice(0, 3) as string[];
              return (
                <div className="dp-gcard" key={r.id} onClick={() => onPlay(r, 0)}>
                  <div className="dp-gposter">
                    <img src={coverUrl(r.cover)} alt={r.title} />
                    {rh > 0 && (
                      <span className="dp-gheat">
                        <Icon name="flame" size={12} strokeWidth={1.8} />
                        {fmtHeat(rh)}
                      </span>
                    )}
                  </div>
                  <div className="dp-gtitle">{r.title}</div>
                  {!!tags.length && (
                    <div className="dp-gtags">
                      {tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="dp-bar">
        <button
          type="button"
          className={`dp-fav${v && isFav(v.id) ? ' on' : ''}`}
          onClick={async () => {
            if (!v) return;
            const on = await toggleFav(v);
            onToast(on ? '已收藏' : '已取消收藏');
          }}
        >
          <Icon name={v && isFav(v.id) ? 'starFill' : 'star'} size={18} strokeWidth={1.9} />
          {v && isFav(v.id) ? '已收藏' : '收藏'}
        </button>
        <button type="button" className="dp-play" onClick={() => v && onPlay(v, prog?.ep || 1)}>
          <Icon name="play" size={16} strokeWidth={2} />
          {prog ? `第${prog.ep}集 · 继续播放` : '开始播放'}
        </button>
      </div>
    </div>
  );
}

