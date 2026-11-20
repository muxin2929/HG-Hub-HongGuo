/**
 * 收藏 / 点赞的唯一状态源。
 *
 * 以前首页右侧的星、播放页右侧的星、详情页底部的收藏各自 useState，
 * 谁也不知道谁点过，也不进账号 → 「三处各点各的、我的里看不到」。
 * 这里做成一份全局状态：
 *   · 登录了就以账号（/api/me/actions）为准，点了立刻回写账号；
 *   · 没登录就落本地存储；
 *   · 所有入口都订阅同一个快照，任一处改动全场立刻同步。
 */
import { auth, getToken } from './auth';
import {
  getFavs,
  getLikeList,
  isFav as storeIsFav,
  isLiked as storeIsLiked,
  toggleFav as storeToggleFav,
  toggleLike as storeToggleLike,
  type FavItem,
} from './store';
import type { Video } from '../data/types';

type Snap = {
  fav: Set<number>;
  like: Set<number>;
  favItems: FavItem[];
  likeItems: FavItem[];
};

let snap: Snap = { fav: new Set(), like: new Set(), favItems: [], likeItems: [] };
let version = 0;
let loadedFor: string | null = null; // 当前快照对应的 token（'' = 未登录）
let loading: Promise<void> | null = null;

const subs = new Set<() => void>();
const emit = () => {
  version += 1;
  subs.forEach((f) => f());
};

export function subscribeMarks(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export function getMarksVersion(): number {
  return version;
}

const toItem = (x: { video_id?: number; id?: number; title: string; cover: string }): FavItem => ({
  id: Number(x.video_id ?? x.id),
  title: x.title || '',
  cover: x.cover || '',
});

/** 拉一次真实状态（登录=账号，未登录=本地）；force 时忽略「已经拉过」的短路 */
export async function loadMarks(force = false): Promise<void> {
  const key = getToken() || '';
  if (!force && loadedFor === key) return;
  if (loading) return loading;

  loading = (async () => {
    if (key) {
      try {
        const [c, l] = await Promise.all([auth.actions('collect'), auth.actions('like')]);
        const favItems = c.map(toItem);
        const likeItems = l.map(toItem);
        snap = {
          fav: new Set(favItems.map((x) => x.id)),
          like: new Set(likeItems.map((x) => x.id)),
          favItems,
          likeItems,
        };
      } catch {
        // 拉取失败（网络/未授权）时保留上一份快照，且不标记「已加载」，下次进页面会重试
        loading = null;
        return;
      }
    } else {
      const favItems = getFavs();
      const likeItems = getLikeList();
      snap = {
        fav: new Set(favItems.map((x) => x.id)),
        like: new Set(likeItems.map((x) => x.id)),
        favItems,
        likeItems,
      };
    }
    loadedFor = key;
    loading = null;
    emit();
  })();

  return loading;
}

/** 登录 / 退出后强制换一份（避免把上一个账号的收藏带过来） */
export function resetMarks(): void {
  loadedFor = null;
  void loadMarks(true);
}

export function marksSnapshot(): Snap {
  return snap;
}
export function isFav(id: number): boolean {
  return snap.fav.has(id);
}
export function isLiked(id: number): boolean {
  return snap.like.has(id);
}

function applyItem(kind: 'collect' | 'like', item: FavItem, on: boolean) {
  const ids = kind === 'collect' ? snap.fav : snap.like;
  const items = kind === 'collect' ? snap.favItems : snap.likeItems;
  const nextItems = on
    ? [item, ...items.filter((x) => x.id !== item.id)]
    : items.filter((x) => x.id !== item.id);
  on ? ids.add(item.id) : ids.delete(item.id);
  snap = {
    ...snap,
    [kind === 'collect' ? 'favItems' : 'likeItems']: nextItems,
  };
}

/** 收藏开关；返回切换后的状态 */
export async function toggleFav(v: Video | FavItem): Promise<boolean> {
  const id = Number(v.id);
  const item: FavItem = { id, title: v.title || '', cover: v.cover || '' };
  const was = snap.fav.has(id);
  applyItem('collect', item, !was);
  emit();
  try {
    if (getToken()) {
      const active = await auth.toggleAction(id, 'collect', item.title, item.cover);
      if (active === null) {
        // 没写进账号（未登录/网络/被拦），不能假装点亮，回到真实状态
        applyItem('collect', item, was);
        emit();
        return was;
      }
      if (active !== !was) applyItem('collect', item, active), emit();
    } else {
      storeToggleFav({ id, title: item.title, cover: item.cover } as Video);
    }
    return !was;
  } catch {
    applyItem('collect', item, was);
    emit();
    return was;
  }
}

/** 点赞开关；返回切换后的状态 */
export async function toggleLike(v: Video | FavItem): Promise<boolean> {
  const id = Number(v.id);
  const item: FavItem = { id, title: v.title || '', cover: v.cover || '' };
  const was = snap.like.has(id);
  applyItem('like', item, !was);
  emit();
  try {
    if (getToken()) {
      const active = await auth.toggleAction(id, 'like', item.title, item.cover);
      if (active === null) {
        applyItem('like', item, was);
        emit();
        return was;
      }
      if (active !== !was) applyItem('like', item, active), emit();
    } else {
      storeToggleLike({ id, title: item.title, cover: item.cover } as Video);
    }
    return !was;
  } catch {
    applyItem('like', item, was);
    emit();
    return was;
  }
}

/** 本地的旧接口继续可用（其他页面读单个 id 时用这两个） */
export const legacy = { isFav: storeIsFav, isLiked: storeIsLiked };
