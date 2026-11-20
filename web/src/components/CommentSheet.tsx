import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../data/api';
import type { Comment } from '../data/types';
import { Icon } from './Icons';
import { auth, getToken } from '../core/auth';

/** 评论面板：底部白色大抽屉，顶部留一条视频画面（对齐红果）。 */
export function CommentSheet({
  videoId,
  title,
  onClose,
  onToast,
}: {
  videoId: number;
  title: string;
  onClose: () => void;
  onToast: (t: string) => void;
}) {
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [liked, setLiked] = useState<Record<number, boolean>>({});
  const [text, setText] = useState('');
  const [mine, setMine] = useState<Comment[]>([]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const p = await api.comments(videoId, page + 1);
      setItems((prev) => [...prev, ...p.items]);
      setPage(p.pagination.page);
      setPages(p.pagination.pages);
      setTotal(p.pagination.total);
    } catch {
      onToast('评论加载失败');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [videoId, page, onToast]);

  useEffect(() => {
    load();
    // 本地/账号评论排在最前（和上游评论合并展示）
    auth.comments(videoId).then((list) => list.length && setMine(list)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 上拉加载更多
  const onScroll = () => {
    const el = boxRef.current;
    if (!el || loading) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && page < pages) load();
  };

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    if (getToken()) {
      auth
        .postComment(videoId, v)
        .then((c) => {
          setMine((m) => [c, ...m]);
          onToast('评论已发布（已同步）');
        })
        .catch((e) => onToast('发布失败：' + (e?.message || e)));
      return;
    }
    const c: Comment = {
      id: Date.now(),
      nickname: '木心',
      content: v,
      text: v,
      time: '刚刚',
      like_count: 0,
      ip_region: '',
    };
    setMine((m) => [c, ...m]);
    onToast('评论已发布（本地，登录后可同步）');
  };

  const all = [...mine, ...items];

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className="commentsheet">
        <div className="csh-head">
          <button type="button" className="csh-close" onClick={onClose} aria-label="收起">
            <Icon name="back" size={22} style={{ transform: 'rotate(-90deg)' }} />
          </button>
          <span className="csh-title">{total ? `${total}条评论` : '评论'}</span>
          <span style={{ width: 22 }} />
        </div>

        <div className="csh-list" ref={boxRef} onScroll={onScroll}>
          {all.length === 0 && !loading && <div className="empty">还没有评论，快来抢沙发</div>}
          {all.map((c) => {
            const open = !!expanded[c.id as number];
            const replies = (c as any).reply_list as Comment[] | undefined;
            return (
              <div className="c-item" key={c.id}>
                <div
                  className="c-av"
                  style={{
                    background: c.avatar ? undefined : (c as any).avatar_color || '#C25B4E',
                  }}
                >
                  {c.avatar ? (
                    <img src={c.avatar} alt="" loading="lazy" />
                  ) : (
                    (c.nickname || '匿').slice(0, 1)
                  )}
                </div>
                <div className="c-body">
                  <div className="c-name">
                    {c.nickname || '匿名用户'}
                    {(c as any).is_pinned && <span className="c-pin">置顶</span>}
                  </div>
                  <div className="c-text">{c.content || c.text}</div>
                  <div className="c-meta">
                    <span>{(c as any).time || (c as any).created_at?.slice(0, 10) || ''}</span>
                    <span className="c-reply" onClick={() => onToast('回复：等待接入')}>
                      回复
                    </span>
                    {(c as any).ip_region && <span className="c-ip">{(c as any).ip_region}</span>}
                    <span className="c-sp" />
                    <button
                      type="button"
                      className={`c-like${liked[c.id as number] ? ' on' : ''}`}
                      onClick={() => setLiked((s) => ({ ...s, [c.id as number]: !s[c.id as number] }))}
                    >
                      <Icon
                        name={liked[c.id as number] ? 'heartFill' : 'heart'}
                        size={15}
                        strokeWidth={1.8}
                      />
                      {(c.like_count || 0) > 0
                        ? (c.like_count || 0) + (liked[c.id as number] ? 1 : 0)
                        : liked[c.id as number]
                          ? 1
                          : '点赞'}
                    </button>
                  </div>
                  {(c as any).reply_count > 0 && (
                    <>
                      <button
                        type="button"
                        className="c-more"
                        onClick={() => setExpanded((s) => ({ ...s, [c.id as number]: !open }))}
                      >
                        {open ? '收起回复' : `展开${(c as any).reply_count}条回复`}
                        <Icon
                          name="chevron"
                          size={12}
                          style={{ transform: `rotate(${open ? -90 : 90}deg)` }}
                        />
                      </button>
                      {open &&
                        (replies && replies.length
                          ? replies.map((r) => (
                              <div className="c-sub" key={r.id}>
                                <b>{r.nickname}</b>：{r.content || r.text}
                              </div>
                            ))
                          : <div className="c-sub muted">回复内容需要上游接口，暂时为空</div>)}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {loading && <div className="c-loading">加载中…</div>}
          {!loading && page >= pages && all.length > 0 && (
            <div className="c-loading">— 已加载全部 {total} 条 —</div>
          )}
        </div>

        <div className="csh-input">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={`有趣评论千千万，不如你也说一句`}
          />
          <button type="button" className="csh-ic" onClick={() => onToast('图片评论：等待接入')}>
            <Icon name="camera" size={21} strokeWidth={1.7} />
          </button>
          <button type="button" className="csh-ic" onClick={() => onToast('表情：等待接入')}>
            <Icon name="smile" size={21} strokeWidth={1.7} />
          </button>
        </div>
      </div>
    </>
  );
}
