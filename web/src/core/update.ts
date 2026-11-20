/**
 * 客户端更新检查：只有 App / 桌面端会提示，网页端永远是最新的、不用提示。
 *  - Android 壳的 UA 里带 HGHubApp/版本
 *  - Windows 壳的 UA 里带 HGDesktop/版本
 * 版本号在构建时通过 VITE_APP_VERSION 注入。
 */
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const LOCAL_VERSION = (import.meta.env.VITE_APP_VERSION as string) || '';

export type Platform = 'android' | 'windows' | 'web';

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/HGHubApp/i.test(ua)) return 'android';
  if (/HGDesktop/i.test(ua)) return 'windows';
  return 'web';
}

export function localVersion(): string {
  const m = navigator.userAgent.match(/HG(?:HubApp|Desktop)\/([\d.]+)/i);
  return m ? m[1] : LOCAL_VERSION;
}

export interface UpdateInfo {
  version: string;
  apk: string;
  win: string;
}

export async function checkUpdate(): Promise<UpdateInfo | null> {
  const p = platform();
  if (p === 'web') return null;
  // 桌面端有 Electron 桥时，用 electron-updater 的检查结果（桌面端版本号和 App 版本号是两套，不能混比）
  const bridge = (window as any).hgUpd;
  if (p === 'windows') {
    if (!bridge?.check) return null; // 旧版桌面壳：没有真实检查通道，宁可不提示也不误报
    try {
      const r = await bridge.check();
      if (!r || !r.version) return null;
      if (r.version === (r.current || localVersion())) return null;
      return { version: String(r.version), apk: '/app.apk', win: '/app-win.exe' };
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(`${BASE}/api/app/version`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const data = json?.data;
    if (!data?.version) return null;
    const local = localVersion();
    if (local && data.version === local) return null;
    return { version: String(data.version), apk: data.apk || '/app.apk', win: data.win || '/app-win.exe' };
  } catch {
    return null;
  }
}
