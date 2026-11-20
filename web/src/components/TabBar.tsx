import { useEffect, useRef } from 'react';
import { Icon, type IconName } from './Icons';
import { shellActive, shellTabBar, shellVisible } from '../core/native';

export type TabKey = 'home' | 'theater' | 'rank' | 'mine';

const TABS: Array<{ key: TabKey; label: string; icon: IconName }> = [
  { key: 'home', label: '首页', icon: 'home' },
  { key: 'theater', label: '剧场', icon: 'theater' },
  { key: 'rank', label: '榜单', icon: 'trophy' },
  { key: 'mine', label: '我的', icon: 'user' },
];

const KEYS = TABS.map((t) => t.key);

/**
 * 底部导航。
 *
 * App 内部：bar 由原生 HgTabBar 画（同一套尺寸 54dp / 图标 23dp / 文字 11sp），
 * 这里只把 React 的切换逻辑（含"再点一次首页重新推荐"）暴露给原生，
 * 并把当前选中项与深浅状态上报给原生，自身不渲染 —— 避免叠出两条导航。
 *
 * 浏览器 / 桌面端：没有 HGShell 桥，照旧渲染网页自己这条。
 */
export function TabBar({
  active,
  dark,
  onChange,
}: {
  active: TabKey;
  dark?: boolean;
  onChange: (k: TabKey) => void;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!shellTabBar) return;
    shellVisible(true);
    (window as any).__hgTab = (k: string) => {
      if (KEYS.indexOf(k as TabKey) >= 0) onChangeRef.current(k as TabKey);
    };
    return () => {
      shellVisible(false);
      delete (window as any).__hgTab;
    };
  }, []);

  useEffect(() => {
    if (shellTabBar) shellActive(active, !!dark);
  }, [active, dark]);

  if (shellTabBar) return null;

  return (
    <nav className={`tabbar${dark ? ' dark' : ''}`}>
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={active === t.key ? 'on' : ''}
          onClick={() => onChange(t.key)}
          aria-current={active === t.key}
        >
          <Icon name={t.icon} size={23} strokeWidth={active === t.key ? 2.1 : 1.75} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
