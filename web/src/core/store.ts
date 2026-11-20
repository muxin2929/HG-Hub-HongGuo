import type { Video } from '../data/types';

/** 本地状态（收藏 / 观看历史 / 续播进度 / 点赞）。三端都用这一份。 */
const ns = (k: string) => `hgr/${k}`;

export interface HistoryItem {
  id: number;
  title: string;
  cover: string;
  ep: number;
  total?: number;
  t: number;
}

export interface Progress {
  ep: number;
  t: number;
  dur: number;
  at: number;
}

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(ns(key));
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(ns(key), JSON.stringify(value));
    } catch {
      /* 隐私模式 / 配额满：静默失败 */
    }
  },
};

export function getHistory(): HistoryItem[] {
  return store.get<HistoryItem[]>('history', []);
}

export function addHistory(v: Video, ep: number) {
  const list = getHistory().filter((x) => x.id !== v.id);
  list.unshift({ id: v.id, title: v.title, cover: v.cover, ep, total: v.episode_count || v.total_episodes || 0, t: Date.now() });
  // 历史只留最近 30 条，只在本地存（不上服务器）
  store.set('history', list.slice(0, 30));
}

export function removeHistory(id: number) {
  store.set('history', getHistory().filter((x) => x.id !== id));
}

export function clearHistory() {
  store.set('history', []);
}

export function getProgress(id: number): Progress | null {
  return store.get<Record<string, Progress>>('progress', {})[String(id)] || null;
}

export function setProgress(id: number, ep: number, t: number, dur: number) {
  const all = store.get<Record<string, Progress>>('progress', {});
  all[String(id)] = { ep, t: Math.floor(t), dur: Math.floor(dur), at: Date.now() };
  store.set('progress', all);
}

export interface FavItem {
  id: number;
  title: string;
  cover: string;
}

export function isFav(id: number): boolean {
  return store.get<FavItem[]>('fav', []).some((x) => x.id === id);
}

export function toggleFav(v: Video): boolean {
  const list = store.get<FavItem[]>('fav', []);
  const has = list.some((x) => x.id === v.id);
  store.set(
    'fav',
    has ? list.filter((x) => x.id !== v.id) : [{ id: v.id, title: v.title, cover: v.cover }, ...list],
  );
  return !has;
}

export function getFavs(): FavItem[] {
  return store.get<FavItem[]>('fav', []);
}

export function getFavIds(): number[] {
  return getFavs().map((x) => x.id);
}

export function getLikeIds(): number[] {
  const all = store.get<Record<string, boolean>>('like', {});
  return Object.keys(all).filter((k) => all[k]).map(Number);
}

export function isLiked(id: number): boolean {
  return !!store.get<Record<number, boolean>>('like', {})[id];
}

/** 未登录时的点赞：布尔图 + 一份带标题封面的清单（我的页要用真标题展示） */
export function toggleLike(v: Video | number): boolean {
  const id = typeof v === 'number' ? v : v.id;
  const all = store.get<Record<number, boolean>>('like', {});
  const next = !all[id];
  all[id] = next;
  store.set('like', all);

  const list = getLikeList();
  if (next) {
    if (typeof v !== 'number') {
      store.set('likeList', [
        { id, title: v.title, cover: v.cover },
        ...list.filter((x) => x.id !== id),
      ]);
    }
  } else {
    store.set('likeList', list.filter((x) => x.id !== id));
  }
  return next;
}

export function getLikeList(): FavItem[] {
  return store.get<FavItem[]>('likeList', []);
}

/** 秒 → 12:34 / 1:02:03 */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 搜索历史（只记用户真搜过的词，最多 12 条） */
export function getSearchHistory(): string[] {
  const v = store.get<string[]>('searchHist', []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
}

export function pushSearchHistory(word: string): string[] {
  const w = (word || '').trim();
  if (!w) return getSearchHistory();
  const keep = getSearchHistory().filter((x) => x !== w);
  keep.unshift(w);
  const next = keep.slice(0, 12);
  store.set('searchHist', next);
  return next;
}

export function clearSearchHistory(): string[] {
  store.set('searchHist', []);
  return [];
}
