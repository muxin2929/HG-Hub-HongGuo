import { Icon, type IconName } from './Icons';
import type { Notice } from '../core/notices';

const ABOUT_URL = 'https://github.com/muxin2929';
const FEEDBACK_URL = 'https://github.com/muxin2929/HG-Hub-HongGuo/issues';

/** 只保留真的能落地的入口：上游没有钱包/设置/偏好这些数据，就不摆空壳 */
const ITEMS: Array<{ label: string; icon: IconName; action: 'update' | 'feedback' | 'about' }> = [
  { label: '检查更新', icon: 'download', action: 'update' },
  { label: '反馈', icon: 'feedback', action: 'feedback' },
  { label: '关于作者', icon: 'info', action: 'about' },
];

export function Drawer({
  onClose,
  onPick,
  notices = [],
  noticeUnread = false,
  onOpenNotices,
}: {
  onClose: () => void;
  onPick: (label: string) => void;
  notices?: Notice[];
  noticeUnread?: boolean;
  onOpenNotices?: () => void;
}) {
  const latest = notices.slice(0, 2);
  return (
    <>
      <div className="mask" onClick={onClose} />
      <aside className="drawer">
        <div className="dgroup">公告</div>
        <button type="button" className="ditem" onClick={() => onOpenNotices?.()}>
          <Icon name="info" size={22} strokeWidth={1.6} />
          <span>公告栏</span>
          {noticeUnread && <i className="dside-dot" />}
          <span className="sp" />
          <Icon name="chevron" className="chev" size={16} />
        </button>
        {latest.map((n) => (
          <button key={n.id} type="button" className="dnews" onClick={() => onOpenNotices?.()}>
            {n.kind === 'release' && <i className="dside-new">NEW</i>}
            <span>{n.title}</span>
          </button>
        ))}

        <div className="dgroup">帮助</div>
        {ITEMS.map((it) => (
          <button
            key={it.label}
            type="button"
            className="ditem"
            onClick={() => {
              if (it.action === 'feedback') {
                window.open(FEEDBACK_URL, '_blank', 'noopener');
                onClose();
                return;
              }
              if (it.action === 'about') {
                window.open(ABOUT_URL, '_blank', 'noopener');
                onClose();
                return;
              }
              onPick(it.label);
            }}
          >
            <Icon name={it.icon} size={22} strokeWidth={1.6} />
            <span>{it.label}</span>
            <span className="sp" />
            <Icon name="chevron" className="chev" size={16} />
          </button>
        ))}
        <div className="dfoot">
          <span>《个人信息清单》</span>
          <span>《三方信息共享清单》</span>
        </div>
      </aside>
    </>
  );
}
