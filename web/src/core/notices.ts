import { API_BASE } from '../data/api';

export interface Notice {
  id: string;
  kind: 'release' | 'notice' | string;
  version?: string;
  title: string;
  body?: string;
  at?: string;
}

export interface NoticeData {
  items: Notice[];
  latest: string;
}

/** 公告来自网关（data/notices.json + 每个版本自动补的发布条目） */
export async function fetchNotices(): Promise<NoticeData> {
  try {
    const res = await fetch(API_BASE + '/api/notices', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { items: [], latest: '' };
    const j: any = await res.json();
    const d = j?.data || {};
    const items: Notice[] = (d.items || []).filter((x: any) => x && x.id && x.title);
    return { items, latest: d.latest || (items[0]?.id ?? '') };
  } catch {
    return { items: [], latest: '' };
  }
}

const READ_KEY = 'hg.notice.read';

export function readIds(): string[] {
  try {
    const raw = localStorage.getItem(READ_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function markRead(id: string): void {
  const cur = readIds();
  if (cur.includes(id)) return;
  const next = [...cur.slice(-80), id];
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
}
