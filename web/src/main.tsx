import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { nativeMode, reportBoot } from './core/native';

// App 壳：满屏显示，不留系统安全区黑边
if (/HGHubApp|HGDesktop/i.test(navigator.userAgent)) {
  document.documentElement.dataset.app = '1';
}

// 原生播放层在 WebView 下面：页面必须让出视频区域的背景，否则会把原生画面盖住
if (nativeMode) document.documentElement.classList.add('hgnative');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 真机上开机自检一次：把各层底色和桥的状态回传到网关日志（只在 App 内）
if (nativeMode) window.setTimeout(reportBoot, 1200);
