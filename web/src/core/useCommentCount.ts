import { useEffect, useState } from 'react';
import { api } from '../data/api';
import type { Video } from '../data/types';

/**
 * 评论数补齐。
 *
 * 上游几个入口是不返回评论数的：
 *   /api/feed/random、/api/ranks/daily、/api/ranks/recommend  —— 只有播放/点赞
 *   /api/videos、/api/videos/<id>                              —— 有 comment_count
 * 于是从首页、榜单点进播放页那一屏，右侧评论数是 0，点开却有一堆评论。
 * 这里在「列表里没有这个数」时按需取一次详情补上（详情接口 10 分钟缓存，不会重复打）。
 */
export function useCommentCount(v: Video, active = true): number {
  const raw = v.comment_count ?? v.counts?.comment;
  const known = typeof raw === 'number' && raw > 0;
  const id = v.id;
  const [n, setN] = useState<number | null>(null);

  useEffect(() => {
    if (!active || known) return;
    let alive = true;
    api
      .video(id)
      .then((d) => {
        if (!alive) return;
        setN(typeof d.comment_count === 'number' ? d.comment_count : 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, active, known]);

  if (known) return raw as number;
  return n ?? 0;
}
