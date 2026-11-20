export function fmtNum(n: number | undefined | null): string {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  // 千万级往上不再带小数，跟参考图的「4029万热度」一致
  if (v >= 10000000) return Math.round(v / 10000) + '万';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

/** 3919万热度 / 2852万热度 */
export function fmtHeat(n: number | undefined | null): string {
  return fmtNum(n) + '热度';
}

/** 5集/188集 */
export function fmtProgress(watched?: number, total?: number): string {
  const t = Number(total) || 0;
  const w = Math.max(1, Number(watched) || 1);
  return `${w}集/${t}集`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 首页顶部两行"弹幕"。真实产品这里是用户评论；在没接评论池之前，
 * 用当前这部剧的简介前两句顶上，至少和画面是对得上的。
 */
export function danmakuOf(description: string | undefined, fallback: string[][]): string[] {
  const text = (description || '').replace(/\s+/g, ' ').trim();
  const parts = text.split(/[。！？!?；;]/).map((s) => s.trim()).filter(Boolean);
  const lines = parts
    .slice(0, 2)
    .map((s) => (s.length > 14 ? s.slice(0, 14) + '…' : s))
    .filter(Boolean);
  return lines.length ? lines : fallback[0];
}
