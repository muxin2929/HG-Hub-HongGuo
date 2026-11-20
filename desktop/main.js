const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  ipcMain,
  Tray,
  nativeImage,
  nativeTheme,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// 1080P 只有 HEVC(HEVC/H.265) 源。Chromium 默认不启用平台解码器，
// 打开后 Windows 上能借系统(MediaFoundation / 显卡驱动)的 HEVC 解码能力；
// 机器本身没有 HEVC 解码器时，页面会自动回退 720P，不会黑屏。
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
// 让 MSE 优先用硬件解码
app.commandLine.appendSwitch('enable-accelerated-video-decode');

// 默认加载线上站点；也可以用 --url=https://xxx 或 HG_URL 环境变量替换
const DEFAULT_URL = process.env.HG_URL || 'https://your-domain.example/';

function findUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  return arg ? arg.slice(6) : DEFAULT_URL;
}

const TEST = process.env.HG_TEST === '1';
let win = null;
let tray = null;
/** 真正要退出的标志：托盘常驻时关窗口只是隐藏，不能拦掉真正的退出/安装 */
let quitting = false;

// ---------------------------------------------------------------- 用户设置
// 关窗口行为等由网页里的「设置」写过来，存 userData，下次启动继续生效
function settingsFile() {
  return path.join(app.getPath('userData'), 'hg-settings.json');
}
let settings = { closeBehavior: 'tray', theme: 'auto' };
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    /* 首次启动没有文件 */
  }
}
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings), 'utf8');
  } catch {
    /* 写不进去不影响运行 */
  }
}
function applyTheme(mode) {
  // Windows 的系统窗口标题栏跟着这里走：暗色 → 深色标题栏，亮色 → 浅色
  nativeTheme.themeSource = mode === 'auto' ? 'system' : mode === 'dark' ? 'dark' : 'light';
}

function ensureTray() {
  if (tray) return tray;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    tray.setToolTip('HG短剧');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示窗口',
          click: () => {
            if (win) {
              win.show();
              win.focus();
            }
          },
        },
        { label: '检查更新', click: () => checkUpdatesManually() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('double-click', () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
  } catch (e) {
    console.log('[tray] ' + e.message);
  }
  return tray;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f1114',
    icon: path.join(__dirname, 'icon.ico'),
    title: 'HG短剧',
    autoHideMenuBar: true,
    show: !TEST,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 允许自动播放（和你手机上一样：静音起播）
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // UA 里带真实版本号：网页端「检查更新」/「已是最新」用的是这个，别写死
  win.webContents.setUserAgent(
    win.webContents.getUserAgent() + ' HGDesktop/' + app.getVersion(),
  );
  win.loadURL(findUrl());

  if (TEST) {
    win.webContents.on('did-finish-load', async () => {
      try {
        const title = await win.webContents.executeJavaScript('document.title');
        const slides = await win.webContents.executeJavaScript("document.querySelectorAll('.slide').length");
        console.log('[test] url=' + win.webContents.getURL() + ' title=' + title + ' slides=' + slides);
      } catch (e) {
        console.log('[test] eval error: ' + e.message);
      }
      if (!process.env.HG_PROBE) setTimeout(() => app.quit(), 600);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('[test] fail ' + code + ' ' + desc);
      app.quit();
    });
  }

  // 站外链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(new URL(findUrl()).origin)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('close', (e) => {
    // 关窗口 ≠ 退出：默认挂到右下角托盘继续跑（用户可在网页「设置」里改成直接退出）
    if (quitting) return;
    if (settings.closeBehavior === 'tray') {
      e.preventDefault();
      win.hide();
      ensureTray();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: '观看',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => win && win.reload() },
        { label: '回到首页', accelerator: 'Alt+Home', click: () => win && win.loadURL(findUrl()) },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '检查更新', click: () => checkUpdatesManually() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开网页版', click: () => shell.openExternal(findUrl()) },
        { label: '关于', click: () => shell.openExternal('https://github.com/muxin2929/HG-Hub-HongGuo') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- 自动更新
// 企业版/个人版都一样：后台下载 → 提示"重启后生效" → 用户重启即完成，无需重装
let updateState = { checking: false, ready: false, version: '' };

function setupUpdater() {
  // 下载交给网页里的更新卡片来按（用户点了才下），壳这边只负责报进度和装
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('hg:upd', ev);
  };

  autoUpdater.on('download-progress', (p) => {
    send({ phase: 'progress', pct: p.percent, bps: p.bytesPerSecond, total: p.total });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState = { checking: false, ready: true, version: info.version };
    if (win) win.setTitle('HG短剧');
    send({ phase: 'done', version: info.version });
  });

  autoUpdater.on('update-available', (info) => {
    updateState = { checking: false, ready: false, version: info.version };
    if (win) win.setTitle(`HG短剧 · 有可用更新 v${info.version}`);
  });

  autoUpdater.on('error', (e) => {
    updateState.checking = false;
    send({ phase: 'error', msg: String((e && e.message) || e) });
    console.log('[update] error', e && e.message);
  });

  ipcMain.handle('hg:upd-check', async () => {
    try {
      const r = await autoUpdater.checkForUpdates();
      return {
        version: (r && r.updateInfo && r.updateInfo.version) || '',
        current: app.getVersion(),
      };
    } catch (e) {
      return { version: '', current: app.getVersion(), error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('hg:upd-download', async () => {
    try {
      autoUpdater.autoDownload = true;
      await autoUpdater.downloadUpdate();
      autoUpdater.autoDownload = false;
      return true;
    } catch (e) {
      send({ phase: 'error', msg: String((e && e.message) || e) });
      return false;
    }
  });

  ipcMain.handle('hg:upd-install', () => {
    // 静默安装：不弹 NSIS 向导，装完自动重新打开（isSilent=true, isForceRunAfter=true）
    quitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => undefined);
  }, 6000);
}

function checkUpdatesManually() {
  if (updateState.ready) {
    dialog
      .showMessageBox(win || undefined, {
        type: 'info',
        title: '更新已就绪',
        message: `v${updateState.version} 已下载完成，重启即生效`,
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => r.response === 0 && ((quitting = true), autoUpdater.quitAndInstall(true, true)))
      .catch(() => undefined);
    return;
  }
  autoUpdater
    .checkForUpdates()
    .then((r) => {
      if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
        dialog.showMessageBox(win || undefined, {
          type: 'info',
          title: '检查更新',
          message: `当前已是最新版本 v${app.getVersion()}`,
        });
      }
    })
    .catch((e) =>
      dialog.showMessageBox(win || undefined, {
        type: 'warning',
        title: '检查更新失败',
        message: String((e && e.message) || e),
      }),
    );
}

function setupSettingsIpc() {
  // 网页设置面板 → 壳：主题 / 关闭行为
  ipcMain.handle('hg:get-settings', () => settings);
  ipcMain.on('hg:setting', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    saveSettings(patch);
    if (patch.theme) applyTheme(patch.theme);
    if (patch.closeBehavior === 'tray') {
      ensureTray();
    } else if (patch.closeBehavior === 'quit' && tray) {
      tray.destroy();
      tray = null;
    }
  });
}

app.whenReady().then(() => {
  loadSettings();
  applyTheme(settings.theme);
  buildMenu();
  createWindow();
  setupUpdater();
  setupSettingsIpc();

  // 空格键交给页面自己处理（播放页 window keydown）。
  // 这里绝不能 globalShortcut.register('Space')：那是系统级独占注册，
  // 会把空格从整个系统抢过来 —— 本窗口不在前台时，连别的程序按空格都被吞掉，
  // 用户感知就是「客户端挂后台以后空格键失效」。

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 菜单「退出」/ 系统关机等真正的退出路径，不能被托盘拦截
  quitting = true;
});

app.on('window-all-closed', () => {
  // 托盘常驻：窗口全关也不退出，从托盘「退出」才真正结束
  if (!quitting && settings.closeBehavior === 'tray') return;
  if (process.platform !== 'darwin') app.quit();
});
