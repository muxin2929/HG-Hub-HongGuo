import type { Video } from '../data/types';
import { API_BASE } from '../data/api';

/** 自建账号（网关 /api/auth/* /api/me/*），token 存 localStorage，Bearer 传。 */
export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar: string;
}

const TKEY = 'hgr/token';
const UKEY = 'hgr/user';

/** 进程内的点赞/收藏缓存（toggle 之后置空，下次重新问服务器） */
let marksCache: { like: Set<number>; collect: Set<number> } | null = null;
let marksPending: Promise<{ like: Set<number>; collect: Set<number> }> | null = null;
export function invalidateMarks() {
  marksCache = null;
  marksPending = null;
}

export function getToken(): string {
  try {
    return localStorage.getItem(TKEY) || '';
  } catch {
    return '';
  }
}

function setAuth(token: string, user: User) {
  try {
    localStorage.setItem(TKEY, token);
    localStorage.setItem(UKEY, JSON.stringify(user));
  } catch {
    /* noop */
  }
}

export function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(UKEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem(TKEY);
    localStorage.removeItem(UKEY);
  } catch {
    /* noop */
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch (e: any) {
    const err: any = new Error(e?.name === 'TimeoutError' ? '请求超时，请重试' : '网络异常，请重试');
    err.network = true;                // 网络问题 ≠ 登录失效
    throw err;
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 0) {
    const err: any = new Error(json.msg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (json.data ?? json) as T;
}

export const auth = {
  async register(username: string, password: string, nickname = ''): Promise<User> {
    const d = await call<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, nickname }),
    });
    setAuth(d.token, d.user);
    return d.user;
  },

  async login(username: string, password: string): Promise<User> {
    const d = await call<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setAuth(d.token, d.user);
    return d.user;
  },

  async me(): Promise<User | null> {
    if (!getToken()) return null;
    try {
      return await call<User>('/api/auth/me');
    } catch (e: any) {
      // 只有服务器明确说「未登录 / token 过期」才清本地；
      // 网络抖动、超时、网关重启都不许把人踢下线（这是之前「老自动下线」的真凶）。
      if (e?.status === 401) {
        clearAuth();
        return null;
      }
      return cachedUser();
    }
  },

  /** 我自己的点赞 / 收藏 id（一次取回，缓存到进程内，toggle 后失效） */
  async marks(): Promise<{ like: Set<number>; collect: Set<number> }> {
    if (!getToken()) return { like: new Set(), collect: new Set() };
    if (marksCache) return marksCache;
    if (marksPending) return marksPending;
    marksPending = (async () => {
      try {
        const [c, l] = await Promise.all([
          call<{ items: any[] }>('/api/me/actions?type=collect'),
          call<{ items: any[] }>('/api/me/actions?type=like'),
        ]);
        const r = {
          like: new Set<number>((l.items || []).map((x) => Number(x.video_id))),
          collect: new Set<number>((c.items || []).map((x) => Number(x.video_id))),
        };
        marksCache = r;
        return r;
      } catch {
        return { like: new Set<number>(), collect: new Set<number>() };
      } finally {
        marksPending = null;
      }
    })();
    return marksPending;
  },

  async logout(): Promise<void> {
    try {
      await call('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 本地也要登出 */
    }
    clearAuth();
  },

  /** 续播 / 历史落库 */
  async saveHistory(v: Video | { id: number; title: string; cover: string; episode_count?: number }, ep: number, position = 0, duration = 0) {
    if (!getToken()) return;
    const id = 'id' in v ? v.id : 0;
    if (!id) return;
    try {
      await call('/api/me/history', {
        method: 'POST',
        body: JSON.stringify({
          video_id: id,
          ep,
          position,
          duration,
          title: (v as any).title,
          cover: (v as any).cover,
          total: (v as any).episode_count || (v as any).total_episodes || 0,
        }),
      });
    } catch {
      /* 离线时忽略 */
    }
  },

  async history(): Promise<Array<{ video_id: number; ep: number; position: number; duration: number; title: string; cover: string; total: number }>> {
    if (!getToken()) return [];
    try {
      const d = await call<{ items: any[] }>('/api/me/history');
      return d.items || [];
    } catch {
      return [];
    }
  },

  async toggleAction(videoId: number, type: 'like' | 'collect', title: string, cover: string): Promise<boolean | null> {
    if (!getToken()) return null;
    try {
      const d = await call<{ active: boolean }>('/api/me/actions', {
        method: 'POST',
        body: JSON.stringify({ video_id: videoId, type, title, cover }),
      });
      invalidateMarks();
      return d.active;
    } catch {
      return null;
    }
  },

  async actions(type: 'like' | 'collect'): Promise<Array<{ video_id: number; title: string; cover: string; created_at: number }>> {
    if (!getToken()) return [];
    // 失败就抛出去：调用方要保留上一份快照，绝不能把「拉取失败」当成「账号里没有」
    const d = await call<{ items: any[] }>(`/api/me/actions?type=${type}`);
    return d.items || [];
  },

  async actionState(videoId: number): Promise<{ like: boolean; collect: boolean } | null> {
    if (!getToken()) return null;
    try {
      return await call(`/api/me/action?video_id=${videoId}`);
    } catch {
      return null;
    }
  },

  async postComment(videoId: number, content: string) {
    return call<any>('/api/me/comment', {
      method: 'POST',
      body: JSON.stringify({ video_id: videoId, content }),
    });
  },

  async comments(videoId: number): Promise<any[]> {
    try {
      const d = await call<{ items: any[] }>(`/api/me/comments?video_id=${videoId}`);
      return d.items || [];
    } catch {
      return [];
    }
  },
};
