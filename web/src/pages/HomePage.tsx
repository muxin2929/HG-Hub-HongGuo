import { useEffect, useState } from 'react';
import type { Video } from '../data/types';
import { api } from '../data/api';
import { useIsDesktop } from '../core/useDesktop';
import { Icon } from '../components/Icons';
import { ChannelFeed } from '../components/ChannelFeed';

/** 顶部频道 → 上游 cate_id（实测：24 短剧 / 25 漫剧） */
const CHANNELS: Array<{ name: string; cate?: string }> = [
  { name: '短剧', cate: '24' },
  { name: '漫剧', cate: '25' },
  { name: '推荐' },
];

/**
 * 首页 = 顶栏 + 三个常驻频道 feed。
 * 三个 feed 同时挂载、各自独立，切频道只是 display 切换，
 * 所以切回来不会重新加载、播放进度不丢。
 */
export function HomePage({
  onOpen,
  onDetail,
  onComment,
  onShare,
  onLandscape,
  onSearch,
  onToast,
  onDrawer,
  refreshKey = 0,
  resumeKey = 0,
  suspend = false,
  visible = true,
  epSync = null,
}: {
  onOpen: (v: Video, ep: number, at?: number) => void;
  onDetail: (id: number) => void;
  onComment: (v: Video) => void;
  onShare: (v: Video, ep: number) => void;
  onLandscape: (v: Video, ep: number, at?: number) => void;
  onSearch: () => void;
  onToast: (t: string) => void;
  onDrawer: () => void;
  refreshKey?: number;
  resumeKey?: number;
  suspend?: boolean;
  visible?: boolean;
  epSync?: { vid: number; ep: number; k: number } | null;
}) {
  const [chan, setChan] = useState('推荐');
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['推荐']));
  const [pcCount, setPcCount] = useState<{ n: number; a: number }>({ n: 0, a: 0 });
  const isDesktop = useIsDesktop();

  useEffect(() => {
    setVisited((prev) => (prev.has(chan) ? prev : new Set(prev).add(chan)));
  }, [chan]);

  // 进首页就把另外两个频道的第一页拉好（切过去直接有内容）
  useEffect(() => {
    CHANNELS.filter((c) => c.name !== '推荐').forEach((c) => {
      api.videos(1, c.cate).catch(() => undefined);
    });
  }, []);

  return (
    <>
      <div className="topbar">
        <button type="button" onClick={onDrawer} aria-label="菜单">
          <Icon name="menu" size={24} strokeWidth={1.9} />
        </button>
        <div className="chan">
          {CHANNELS.map((c) => (
            <span key={c.name} className={c.name === chan ? 'on' : ''} onClick={() => setChan(c.name)}>
              {c.name}
              {c.name === '推荐' && <span className="caret">⌃</span>}
            </span>
          ))}
        </div>
        <button type="button" onClick={onSearch} aria-label="搜索">
          <Icon name="search" size={23} strokeWidth={1.9} />
        </button>
        {isDesktop && pcCount.n > 0 && (
          <div className="pc-count">
            <b>{pcCount.a + 1}</b> / {pcCount.n}
            <span>滚轮 / ↑↓ 切换</span>
          </div>
        )}
      </div>

      <div className="home-wrap">
        {CHANNELS.map((c) => (
          <div key={c.name} className={`cfwrap${c.name === chan ? ' on' : ''}`}>
            {visited.has(c.name) && (
              <ChannelFeed
                chan={c.name}
                cate={c.cate}
                on={c.name === chan && visible}
                refreshKey={c.name === '推荐' ? refreshKey : 0}
                resumeKey={resumeKey}
                suspend={suspend}
                epSync={epSync}
                onOpen={onOpen}
                onDetail={onDetail}
                onComment={onComment}
                onShare={onShare}
                onLandscape={onLandscape}
                onToast={onToast}
                onCount={(n: number, a: number) => {
                  if (c.name === chan) setPcCount({ n, a });
                }}
              />
            )}
          </div>
        ))}
      </div>
    </>
  );
}
