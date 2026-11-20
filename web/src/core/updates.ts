import { useEffect, useState } from 'react';
import { api, API_BASE } from '../data/api';

const KEY = 'hg.upstream.stamp';
const CHECK_MS = 120000;

export interface FreshInfo {
  stamp: string;
  latest_id: number;
  latest_title: string;
  total: number;
}

/**
 * 上游内容更新检查：每 2 分钟问一次「最新一条 + 总数」。
 * 变了就提示用户刷新（不会自己打断正在看的内容）。
 */
export function useUpstreamUpdates() {
  const [fresh, setFresh] = useState<FreshInfo | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(API_BASE + '/api/feed/version', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json: any = await res.json();
        const d = json?.data;
        if (!d?.stamp || stopped) return;
        const seen = localStorage.getItem(KEY);
        if (!seen) {
          localStorage.setItem(KEY, d.stamp);
          return;
        }
        if (seen !== d.stamp) setFresh(d as FreshInfo);
      } catch {
        /* 忽略 */
      }
    };
    check();
    const timer = window.setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const accept = () => {
    if (fresh) localStorage.setItem(KEY, fresh.stamp);
    setFresh(null);
    api.clearCache();
  };

  /**
   * 关掉 = 这一批上新「我知道了」。必须把 stamp 落盘，否则下一次轮询
   * 拿同一个 stamp 又来弹一遍——用户会被同一条上新反复打扰。
   * 等上游真的又进了新剧（stamp 再变）才重新提示一次。
   */
  const dismiss = () => {
    if (fresh) localStorage.setItem(KEY, fresh.stamp);
    setFresh(null);
  };

  return { fresh, accept, dismiss };
}
