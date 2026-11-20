import { store } from './store';

export type ThemeMode = 'light' | 'dark' | 'auto';
/** 点窗口右上角关闭时：挂到右下角托盘继续跑 / 直接退出 */
export type CloseBehavior = 'tray' | 'quit';

export type AppSettings = {
  theme: ThemeMode;
  closeBehavior: CloseBehavior;
};

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  closeBehavior: 'tray',
};

export function loadSettings(): AppSettings {
  const saved = store.get<Partial<AppSettings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** 只有能落地的项才写在这里：主题、关闭行为 */
export function saveSettings(next: AppSettings) {
  store.set('settings', next);
  // 同步给桌面壳（主题会改系统窗口标题栏的亮/暗）
  try {
    (window as any).hgDesktop?.setSettings?.({
      theme: next.theme,
      closeBehavior: next.closeBehavior,
    });
  } catch {
    /* 网页端没有这个桥 */
  }
}

/** 壳里存的设置（首次进桌面端时以壳为准，保证两边一致） */
export async function pullShellSettings(): Promise<Partial<AppSettings> | null> {
  try {
    const s = await (window as any).hgDesktop?.getSettings?.();
    if (!s) return null;
    return { theme: s.theme, closeBehavior: s.closeBehavior };
  } catch {
    return null;
  }
}
