import { platform, type UpdateInfo } from './update';

/** 下载/安装过程的事件：进度、完成、失败 */
export type UpdEvent = {
  phase: 'progress' | 'done' | 'error';
  pct?: number;
  bps?: number;
  total?: number;
  msg?: string;
};

type Cb = (e: UpdEvent) => void;

/** Android 壳的 JavaScriptInterface（MainActivity 里注册的 HGShell） */
const androidShell = (): any => (window as any).HGShell;

let androidCb: Cb | null = null;
// 原生侧不认回调，统一往这里推：window.__hgUpd({phase,pct,...})
(window as any).__hgUpd = (e: UpdEvent) => {
  androidCb?.(e);
};

export type UpdChannel = 'android' | 'electron' | 'web';

export function updateChannel(): UpdChannel {
  if (platform() === 'android' && androidShell()?.updateDownload) return 'android';
  if ((window as any).hgUpd?.download) return 'electron';
  // 老版桌面壳还没有桥 → 仍然当桌面端，下载会退化成系统浏览器
  if (platform() === 'windows') return 'electron';
  return 'web';
}

export function absUrl(p?: string): string {
  if (!p) return '';
  if (/^https?:/i.test(p)) return p;
  const base = (import.meta.env.VITE_API_BASE as string | undefined) || location.origin;
  return base.replace(/\/$/, '') + p;
}

export function subscribeUpdate(cb: Cb): () => void {
  // 原生侧的进度是往 window.__hgUpd 推的，跟「当前判定成哪个通道」无关：
  // 先无条件挂上，免得壳的接口注入得比顶层的判定晚一步就收不到进度。
  androidCb = cb;
  if (updateChannel() === 'electron') {
    const bridge = (window as any).hgUpd;
    if (bridge?.onEvent) {
      const off = bridge.onEvent(cb);
      return () => {
        if (androidCb === cb) androidCb = null;
        off?.();
      };
    }
  }
  return () => {
    if (androidCb === cb) androidCb = null;
  };
}

/** 开始应用内下载；返回 'native' 表示由壳接管，'browser' 表示退化成了系统下载 */
export async function downloadUpdate(info: UpdateInfo): Promise<'native' | 'browser'> {
  const ch = updateChannel();
  if (ch === 'android') {
    androidShell().updateDownload(absUrl(info.apk));
    return 'native';
  }
  if (ch === 'electron') {
    const bridge = (window as any).hgUpd;
    if (bridge?.download) {
      await bridge.download();
      return 'native';
    }
    // 老桌面壳：直接交给系统下载安装包，用户自己装
    window.open(absUrl(info.win), '_blank');
    return 'browser';
  }
  window.open(absUrl(info.apk || info.win), '_blank');
  return 'browser';
}

export function installUpdate(): void {
  const ch = updateChannel();
  if (ch === 'android') {
    androidShell()?.updateInstall?.();
    return;
  }
  if (ch === 'electron') (window as any).hgUpd?.install?.();
}
