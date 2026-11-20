// 页面 ↔ 桌面壳：更新检查 / 下载进度 / 安装（只在 Electron 里有效）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hgUpd', {
  /** 检查更新 → {version, current, error?} */
  check: () => ipcRenderer.invoke('hg:upd-check'),
  /** 开始下载（进度通过 onEvent 推回来） */
  download: () => ipcRenderer.invoke('hg:upd-download'),
  /** 关掉应用、装好、再打开 */
  install: () => ipcRenderer.invoke('hg:upd-install'),
  /** 订阅进度：cb({phase:'progress'|'done'|'error', pct, bps, total, msg}) */
  onEvent: (cb) => {
    const h = (_e, ev) => {
      try {
        cb(ev);
      } catch {
        /* noop */
      }
    };
    ipcRenderer.on('hg:upd', h);
    return () => ipcRenderer.removeListener('hg:upd', h);
  },
});

contextBridge.exposeInMainWorld('hgDesktop', {
  platform: process.platform,
  version: process.versions.electron,
  /** 读壳侧设置：{ closeBehavior: 'tray'|'quit', theme: 'light'|'dark'|'auto' } */
  getSettings: () => ipcRenderer.invoke('hg:get-settings'),
  /** 写壳侧设置（主题会同步到系统窗口标题栏颜色） */
  setSettings: (patch) => ipcRenderer.send('hg:setting', patch),
});
