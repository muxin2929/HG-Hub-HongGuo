import { Icon } from '../components/Icons';

/** 下载页：Android / Windows 二选一（网页、APK、桌面端都指到同一个图标） */
export function DownloadPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="dlpage">
      <header className="dlhead">
        <button type="button" className="msg-back" onClick={onBack} aria-label="返回">
          <Icon name="back" size={22} strokeWidth={2} />
        </button>
        <span className="dltitle">下载客户端</span>
        <span style={{ width: 22 }} />
      </header>

      <div className="dlbody">
        <div className="dlcard">
          <div className="dllogo">
            <img src="/icon-192.png" alt="HG短剧" />
          </div>
          <div className="dlmeta">
            <h3>HG短剧 · 安卓版</h3>
            <p>APK · 约 0.4 MB · Android 7.0+</p>
            <p className="dlhint">内置离线首屏，打开秒出界面；内容与网页端同步</p>
          </div>
          <a className="dlbtn" href="/app.apk" download>
            <Icon name="download" size={17} strokeWidth={2} />
            下载 APK
          </a>
        </div>

        <div className="dlcard">
          <div className="dllogo">
            <img src="/icon-192.png" alt="HG短剧" />
          </div>
          <div className="dlmeta">
            <h3>HG短剧 · Windows 版</h3>
            <p>安装包 · 约 116 MB · Win10/11 x64</p>
            <p className="dlhint">桌面端全屏播放、滚轮切换、进度条悬停预览</p>
          </div>
          <a className="dlbtn" href="/app-win.exe" download>
            <Icon name="download" size={17} strokeWidth={2} />
            下载安装包
          </a>
        </div>

        <div className="dlnote">
          <p>· 手机也可以直接用浏览器打开本站，效果和 App 一样，还能「添加到主屏」。</p>
          <p>· iOS 请用 Safari 打开网页版；APK 仅支持 Android。</p>
        </div>
      </div>
    </div>
  );
}
