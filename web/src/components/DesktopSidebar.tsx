import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icons';
import type { User } from '../core/auth';
import type { Notice } from '../core/notices';

export type TabKey = 'home' | 'theater' | 'rank' | 'mine';
/** 我的页里的四个标签，PC 侧栏可以直接定位 */
export type MineTab = '历史' | '收藏' | '追更' | '点赞';

type Action = 'toast' | 'login' | 'update' | 'feedback' | 'about' | 'settings';

type Item = {
  key: string;
  label: string;
  icon: IconName;
  primary?: boolean;
  action?: Action;
  tab?: TabKey;
  mineTab?: MineTab;
};

const DISCOVER: Item[] = [
  { key: 'rec', label: '推荐', icon: 'home', primary: true, tab: 'home' },
  { key: 'find', label: '找剧', icon: 'search', primary: true, tab: 'theater' },
  { key: 'rank', label: '排行榜', icon: 'trophy', primary: true, tab: 'rank' },
  { key: 'new', label: '新剧', icon: 'play', primary: true },
];

/** 桌面端自己有安装包，不需要「下载」这个入口（手机端抽屉同理） */
const MINE: Item[] = [
  { key: 'hist', label: '历史', icon: 'clock', primary: true, mineTab: '历史' },
  { key: 'fav', label: '收藏', icon: 'star', primary: true, mineTab: '收藏' },
  { key: 'follow', label: '追更', icon: 'calendar', primary: true, mineTab: '追更' },
  { key: 'like', label: '点赞', icon: 'heart', primary: true, mineTab: '点赞' },
];

const HELP: Item[] = [
  { key: 'upd', label: '检查更新', icon: 'download', action: 'update' },
  { key: 'fb', label: '反馈', icon: 'feedback', action: 'feedback' },
  { key: 'about', label: '关于作者', icon: 'info', action: 'about' },
  { key: 'setting', label: '设置', icon: 'settings', action: 'settings' },
];

const ABOUT_URL = 'https://github.com/muxin2929';
const FEEDBACK_URL = 'https://github.com/muxin2929/HG-Hub-HongGuo/issues';

/** PC 端左侧导航（发现 / 我的 / 公告 可滚动，帮助 + 账号固定在底部） */
export function DesktopSidebar({
  activeKey,
  user,
  collapsed,
  notices,
  noticeUnread,
  onToggleCollapse,
  onChange,
  onMine,
  onNew,
  onToast,
  onLogin,
  onLogout,
  onOpenNotices,
  onCheckUpdate,
  onSettings,
}: {
  /** 当前高亮的侧栏项：「新剧」和「找剧」都在剧场 tab，只能靠它区分 */
  activeKey: string;
  user: User | null;
  collapsed: boolean;
  notices: Notice[];
  noticeUnread: boolean;
  onToggleCollapse: () => void;
  onChange: (t: TabKey) => void;
  onMine: (t: MineTab) => void;
  onNew: () => void;
  onToast: (t: string) => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenNotices: () => void;
  onCheckUpdate: () => void;
  onSettings: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--side-w', collapsed ? '76px' : '236px');
  }, [collapsed]);

  // 展开的帮助面板：点别处就收起
  useEffect(() => {
    if (!helpOpen) return;
    const on = (e: MouseEvent) => {
      if (!helpRef.current?.contains(e.target as Node)) setHelpOpen(false);
    };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [helpOpen]);

  const fire = (it: Item) => {
    if (it.key === 'new') onNew();
    else if (it.tab) onChange(it.tab);
    else if (it.mineTab) onMine(it.mineTab);
    else if (it.action === 'login') onLogin();
    else if (it.action === 'update') onCheckUpdate();
    else if (it.action === 'feedback') window.open(FEEDBACK_URL, '_blank', 'noopener');
    else if (it.action === 'about') window.open(ABOUT_URL, '_blank', 'noopener');
    else if (it.action === 'settings') onSettings();
    else onToast(`${it.label}：等待接入`);
  };

  const renderItem = (it: Item) => {
    const active = !!it.primary && it.key === activeKey;
    return (
      <button
        key={it.key}
        type="button"
        className={`dside-item${active ? ' on' : ''}`}
        title={it.label}
        onClick={() => fire(it)}
      >
        <Icon name={it.icon} size={19} strokeWidth={1.8} />
        {!collapsed && <span>{it.label}</span>}
      </button>
    );
  };

  return (
    <aside className={`dside${collapsed ? ' collapsed' : ''}`}>
      <div className="dside-brand">
        <span className="dside-logo">HG</span>
        {!collapsed && <b>短剧</b>}
        <button type="button" className="dside-fold" onClick={onToggleCollapse} title="收起 / 展开">
          <Icon name="back" size={16} style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }} />
        </button>
      </div>

      <div className="dside-scroll">
        <div className="dside-group">
          {!collapsed && <div className="dside-label">发现</div>}
          {DISCOVER.map(renderItem)}
        </div>

        <div className="dside-group">
          {!collapsed && <div className="dside-label">我的</div>}
          {MINE.map(renderItem)}
        </div>

        <div className="dside-group dside-noticebox">
          {!collapsed && <div className="dside-label">公告</div>}
          <button type="button" className="dside-item" title="公告" onClick={onOpenNotices}>
            <Icon name="info" size={19} strokeWidth={1.8} />
            {!collapsed && <span>公告栏</span>}
            {noticeUnread && <i className="dside-dot" />}
          </button>
          {!collapsed &&
            notices.slice(0, 2).map((n) => (
              <button
                key={n.id}
                type="button"
                className="dside-news"
                title={n.title}
                onClick={onOpenNotices}
              >
                {n.kind === 'release' && <i className="dside-new">NEW</i>}
                <span>{n.title}</span>
              </button>
            ))}
        </div>
      </div>

      <div className="dside-bottom">
        <div className="dside-helpwrap" ref={helpRef}>
          {helpOpen && (
            <div className="dside-helppop">
              {HELP.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className="dside-item"
                  title={it.label}
                  onClick={() => {
                    setHelpOpen(false);
                    fire(it);
                  }}
                >
                  <Icon name={it.icon} size={18} strokeWidth={1.8} />
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="dside-item dside-helpbtn"
            title="帮助"
            onClick={() => setHelpOpen((v) => !v)}
          >
            <Icon name="info" size={19} strokeWidth={1.8} />
            {!collapsed && (
              <>
                <span>帮助</span>
                <span className="dside-chev">
                  <Icon name="chevron" size={14} style={{ transform: helpOpen ? 'rotate(90deg)' : 'rotate(-90deg)' }} />
                </span>
              </>
            )}
          </button>
        </div>

        <div className="dside-user">
          <span className="dside-av">{(user?.nickname || user?.username || '游').slice(0, 1)}</span>
          {!collapsed && (
            <div className="dside-uinfo">
              <b>{user ? user.nickname || user.username : '未登录'}</b>
              <button type="button" onClick={user ? onLogout : onLogin}>
                {user ? '退出登录' : '登录 / 注册'}
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
