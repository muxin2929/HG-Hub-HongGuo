import { useState } from 'react';
import { Icon } from './Icons';

/** 分享面板：复制链接 / 微信 / QQ / 系统分享 / 下载 App。 */
export function ShareSheet({
  link,
  title,
  onClose,
  onToast,
  onDownload,
}: {
  link: string;
  title: string;
  onClose: () => void;
  onToast: (t: string) => void;
  onDownload: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    onToast('链接已复制');
  };

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className={`sharesheet${window.innerWidth > window.innerHeight ? ' ss-land' : ''}`}>
        <div className="ss-head">
          <span>分享《{title}》</span>
          <button type="button" className="csh-close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="ss-grid">
          <button type="button" onClick={copy}>
            <span className="ss-ic" style={{ background: '#eef1f5', color: '#2b3a4a' }}>
              <Icon name="share" size={20} strokeWidth={1.9} />
            </span>
            {copied ? '已复制' : '复制链接'}
          </button>
          <button type="button" onClick={() => onToast('微信分享：需要接入 SDK')}>
            <span className="ss-ic" style={{ background: '#e8f8ec', color: '#2bb35a' }}>
              <Icon name="chat" size={20} strokeWidth={1.9} />
            </span>
            微信
          </button>
          <button type="button" onClick={onDownload}>
            <span className="ss-ic" style={{ background: '#e8f2ff', color: '#2f7bd8' }}>
              <Icon name="chat" size={20} strokeWidth={1.9} />
            </span>
            下载 App
          </button>
          <button
            type="button"
            onClick={async () => {
              if (navigator.share) {
                try {
                  await navigator.share({ title, url: link });
                } catch {
                  /* 用户取消 */
                }
              } else onToast('当前环境不支持系统分享');
            }}
          >
            <span className="ss-ic" style={{ background: '#fdf0e6', color: '#e08a3c' }}>
              <Icon name="expand" size={20} strokeWidth={1.9} />
            </span>
            系统分享
          </button>
        </div>
        <div className="ss-link" onClick={copy}>
          {link}
        </div>
      </div>
    </>
  );
}
