import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TabBar, type TabKey } from './components/TabBar';

const TAB_ORDER: TabKey[] = ['home', 'theater', 'rank', 'mine'];
import { DesktopSidebar, type MineTab } from './components/DesktopSidebar';
import { useIsDesktop } from './core/useDesktop';
import { Drawer } from './components/Drawer';
import { EpisodePlayer } from './components/EpisodePlayer';
import { LandscapePlayer } from './components/LandscapePlayer';
import { DownloadPage } from './pages/DownloadPage';
import { CommentSheet } from './components/CommentSheet';
import { ShareSheet } from './components/ShareSheet';
import { HomePage } from './pages/HomePage';
import { TheaterPage } from './pages/TheaterPage';
import { ProfilePage } from './pages/ProfilePage';
import { RankPage } from './pages/RankPage';
import { DetailPage } from './pages/DetailPage';
import { SearchPage } from './pages/SearchPage';
import { api } from './data/api';
import { getProgress, store } from './core/store';
import { loadMarks, resetMarks } from './core/marks';
import { auth, cachedUser, type User } from './core/auth';
import { checkUpdate, localVersion, platform, type UpdateInfo } from './core/update';
import { useUpstreamUpdates } from './core/updates';
import { warmupContent } from './core/warmup';
import { fetchNotices, markRead, readIds, type Notice } from './core/notices';
import { UpdateCard } from './components/UpdateCard';
import { NoticeSheet } from './components/NoticeSheet';
import { updateChannel } from './core/appUpdate';
import { LoginSheet } from './components/LoginSheet';
import { SettingsSheet } from './components/SettingsSheet';
import {
  type AppSettings,
  loadSettings,
  pullShellSettings,
  saveSettings,
} from './core/settings';
import { engine, livePlayback, nativeMode, shellActive, shellTabBar } from './core/native';
import { pauseFeedVideos } from './core/player';
import type { Video } from './data/types';
import './styles.css';

type Overlay =
  | { kind: 'detail'; id: number }
  | { kind: 'search'; q?: string }
  | { kind: 'player'; v: Video; ep: number; at?: number; feed?: boolean }
  | { kind: 'comments'; id: number; title: string }
  | { kind: 'share'; v: Video; ep: number }
  | { kind: 'login' }
  | { kind: 'landscape'; v: Video; ep: number; at?: number }
  | { kind: 'download' };

export default function App() {
  const [tab, setTab] = useState<TabKey>('home');
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stack, setStack] = useState<Overlay[]>([]);
  // 外观与关闭行为：PC 设置面板可改，存在本地并同步给桌面壳
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [sysDark, setSysDark] = useState(
    () => (window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false),
  );
  const theme: 'light' | 'dark' =
    settings.theme === 'auto' ? (sysDark ? 'dark' : 'light') : settings.theme;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const patchSettings = (p: Partial<AppSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...p };
      saveSettings(next);
      return next;
    });
  };
  const [updCard, setUpdCard] = useState<UpdateInfo | null>(null);
  const { fresh, accept, dismiss } = useUpstreamUpdates();
  const [homeRefresh, setHomeRefresh] = useState(0);
  // 播放页/详情页关回来时，让首页那一屏接着播
  const [homeResume, setHomeResume] = useState(0);
  /** 播放页退出时带回的「这部看到第几集」：首页要停在同一集，而不是永远第一集 */
  const [homeSync, setHomeSync] = useState<{ vid: number; ep: number; k: number } | null>(null);
  /** 播放页关闭时先记着它看到第几集，等首页真正回到台前再写下去（否则会抢在原生交还画面前重挂流） */
  const pendingHomeSync = useRef<{ vid: number; ep: number } | null>(null);
  /** 全屏里换了集：交回下面那一层播放页，让它接着播这一集 */
  const [playerSync, setPlayerSync] = useState<{ ep: number; at: number; k: number } | null>(null);
  /** 竖屏播放页当前那个 <video>：进全屏时把这同一个元素交给全屏页用，不重新取流 */
  const stageVideoRef = useRef<HTMLVideoElement | null>(null);
  // 进全屏前占着原生画面的那个壳：退出全屏时把画面还给它
  const prevPlayRef = useRef<any>(null);
  // 访问过的 tab 一直挂载着（切换回来不重新加载、不丢进度）
  const [mounted, setMounted] = useState<Set<TabKey>>(() => new Set<TabKey>(['home']));
  useEffect(() => {
    setMounted((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  // 切 tab / 换主题时再给原生底部导航报一次深浅（首页始终深色，其余跟主题）
  // TabBar 里也会报，这里是双保险：避免只在某一处生效
  useEffect(() => {
    if (shellTabBar) shellActive(tab, tab === 'home' || theme === 'dark');
  }, [tab, theme]);

  /**
   * 切 tab 时四个 pane 在整条轨道上滑动，而 App 内的原生画面是「屏幕层」，不会跟着滑：
   * 不藏起来就会看到残留画面，切回首页时还会出现「视频框先偏左、再突然铺满」。
   * 做法：滑动期间先藏原生层，滑完（0.26s 动画 + 余量）再按新位置量一次矩形后显示。
   */
  const tabRef = useRef(tab);
  const stackLenRef = useRef(0);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    stackLenRef.current = stack.length;
  }, [stack.length]);
  const tabInited = useRef(false);
  // 用 layout effect：在浏览器绘制这一帧之前就把原生层扣住，
  // 否则先画一帧「轨道已经动了、画面还停在原位」，就是用户看到的错位截图。
  useLayoutEffect(() => {
    if (!nativeMode) return;
    if (!tabInited.current) {
      tabInited.current = true;
      return; // 首屏不折腾，避免启动时黑一下
    }
    let dropped = false;
    engine.holdVisible();
    const pane = document.querySelector('.app > .panes') as HTMLElement | null;
    let fallback = 0;
    let raf = 0;
    let done = false;
    const finish = () => {
      if (dropped || done) return;
      done = true;
      window.clearTimeout(fallback);
      // 轨道已经停在最终位置：按新矩形对齐后再放行，
      // 早一帧放行就会看到画面还在旧位置（用户截图的那种偏左）。
      engine.syncRect(true);
      raf = requestAnimationFrame(() => {
        if (dropped) return;
        engine.syncRect(true);
        engine.releaseVisible(tabRef.current === 'home' && stackLenRef.current === 0);
      });
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === pane && e.propertyName === 'transform') finish();
    };
    if (pane) {
      pane.addEventListener('transitionend', onEnd);
      // 兜底：系统开了「减少动态效果」或过渡被跳过时 transitionend 不会来
      fallback = window.setTimeout(finish, 420);
    } else {
      fallback = window.setTimeout(finish, 420);
    }
    return () => {
      dropped = true;
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
      pane?.removeEventListener('transitionend', onEnd);
    };
  }, [tab]);

  // 客户端启动后问一次版本（网页端不提示）：有更新就直接弹那张更新卡
  useEffect(() => {
    const SHOWN = 'hg.upd.shown';
    checkUpdate()
      .then((u) => {
        if (!u) return;
        // 同一个版本只在启动时弹一次，别每次开都糊一脸；手动「检查更新」仍然会弹
        if (localStorage.getItem(SHOWN) === u.version) return;
        localStorage.setItem(SHOWN, u.version);
        setUpdCard(u);
      })
      .catch(() => undefined);
  }, []);

  /** 更新卡片上的卖点：取自该版本的发布公告（没有就留空，卡片显示默认一行） */
  const notesForVersion = (v: string): string[] => {
    const n = notices.find((x) => x.version === v);
    if (!n?.body) return [];
    return n.body
      .split(/[\n；;]+/)
      .map((s) => s.replace(/^[-·•\s]+/, '').trim())
      .filter(Boolean);
  };

  /** 侧边栏「检查更新」：手动问一次，有就弹卡，没有就提示当前已最新 */
  const manualCheck = async () => {
    if (updateChannel() === 'web') {
      setToast('网页版始终是最新版，无需更新');
      return;
    }
    try {
      const u = await checkUpdate();
      if (u) {
        setUpdCard(u);
        return;
      }
      setToast(`已是最新版本 v${localVersion() || ''}`.replace(/\s+$/, ''));
    } catch {
      setToast('检查更新失败，请稍后重试');
    }
  };

  // 公告：侧边栏公告栏 + 「有版本更新才弹」的那张卡片
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [, setNoticeReadPing] = useState(0);
  const noticeRead = readIds();
  const noticeUnread = notices.length > 0 && !noticeRead.includes(notices[0].id);
  useEffect(() => {
    fetchNotices()
      .then((d) => setNotices(d.items))
      .catch(() => undefined);
  }, []);

  // 启动就把首页/剧场/榜单/搜索要用的接口与封面热一遍（开屏那 1 秒多正好拿来干这个）
  useEffect(() => {
    warmupContent();
  }, []);
  const [user, setUser] = useState<User | null>(() => cachedUser());
  const isDesktop = useIsDesktop();
  const [sideCollapsed, setSideCollapsed] = useState<boolean>(() => store.get('sideCollapsed', false));
  const [theaterSort, setTheaterSort] = useState<'default' | 'new' | 'hot' | 'episodes'>('default');
  /** PC 侧栏当前高亮项：剧场 tab 里「找剧」和「新剧」是两个入口，我的页里也有四个标签 */
  const [sidePick, setSidePick] = useState('rec');
  const [mineTab, setMineTab] = useState<MineTab>('历史');

  // 从别的入口（播放页返回、深链等）切 tab 时，侧栏高亮跟着回到该 tab 的默认项
  useEffect(() => {
    if (tab === 'home') setSidePick('rec');
    else if (tab === 'rank') setSidePick('rank');
    else if (tab === 'theater') setSidePick((p) => (p === 'new' ? 'new' : 'find'));
    else if (tab === 'mine') {
      setSidePick((p) => (['hist', 'fav', 'follow', 'like'].includes(p) ? p : 'hist'));
    }
  }, [tab]);

  // 启动时校验一次 token（失效就清掉本地），顺便把收藏/点赞的真实状态拉回来
  useEffect(() => {
    auth
      .me()
      .then((u) => {
        setUser(u);
        void loadMarks(true);
      })
      .catch(() => setUser(null));
  }, []);

  // 夜间模式：写到 <html data-theme>，CSS 变量整体切换，三端一致
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.set('theme', theme);
  }, [theme]);

  // 跟随系统：系统亮暗变了要立刻跟上（PC 也顺手把窗口标题栏色同步给壳）
  useEffect(() => {
    try {
      (window as any).hgDesktop?.setSettings?.({ theme: settings.theme });
    } catch {
      /* 网页端没有桥 */
    }
    if (settings.theme !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [settings.theme]);

  // 桌面端首次进来：以壳里存的设置为准（两边不要各说各话）
  useEffect(() => {
    pullShellSettings()
      .then((s) => {
        if (!s) return;
        if (s.theme && s.theme !== settings.theme) patchSettings({ theme: s.theme });
        if (s.closeBehavior && s.closeBehavior !== settings.closeBehavior)
          patchSettings({ closeBehavior: s.closeBehavior });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(id);
  }, [toast]);

  // 深链：/?v=12&ep=3 打开详情+播放；/?q=关键词 直接搜索
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('download')) {
      setStack([{ kind: 'download' }]);
      return;
    }
    const q = p.get('q');
    if (q) {
      setStack([{ kind: 'search', q }]);
      return;
    }
    const v = p.get('v');
    if (!v) return;
    const id = Number(v);
    if (!id) return;
    const ep = Number(p.get('ep') || 0);
    setStack([{ kind: 'detail', id }]);
    if (ep > 0) {
      api
        .video(id)
        .then((d) => setStack([{ kind: 'player', v: d, ep }]))
        .catch(() => undefined);
    }
  }, []);

  // 返回键：逐层关闭
  useEffect(() => {
    const onPop = () => setStack((s) => s.slice(0, -1));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = (o: Overlay) => {
    setStack((s) => [...s, o]);
    history.pushState({ ov: true }, '');
  };
  const back = () => {
    if (stack.length) history.back();
    else setStack([]);
  };

  /**
   * 打开播放页：ep 不传就接着上次看到的那一集。
   * feed=true 只有首页那一屏会传，用于借用首页已经在播的 <video>（同部同集才成立）。
   */
  const openPlayer = (v: Video, ep?: number, at?: number, feed?: boolean) => {
    const saved = getProgress(v.id);
    // 会话里还在播的就是这一部：就沿用它那一集和进度，别退回第一集重头加载
    const lp = livePlayback();
    const live = lp && lp.vid === String(v.id) ? lp : null;
    const want = ep && ep > 0 ? ep : live?.ep || saved?.ep || 1;
    const from = at && at > 2 ? at : live && live.ep === want && live.t > 2 ? live.t : at;
    push({ kind: 'player', v, ep: want, at: from, feed });
  };

  // 离开首页 / 有覆盖层盖上来：立刻停掉首页正在播的视频，别让它在后面继续放、还有声音。
  // 回到首页且没有覆盖层：再让它接着播（homeResume 计数驱动）。
  useEffect(() => {
    if (tab === 'home' && stack.length === 0) {
      // 先把播放页交回的集数落给首页（这时播放页已经卸载、原生也已交还，不会抢流）
      const p = pendingHomeSync.current;
      if (p) {
        pendingHomeSync.current = null;
        setHomeSync({ ...p, k: Date.now() });
      }
      setHomeResume((n) => n + 1);
      return;
    }
    pauseFeedVideos();
  }, [tab, stack.length]);

  // App 内是虚拟域名（appassets），分享链接必须用构建时配置的公开站点地址。
  // 自建时在 web/.env.production 里设置 VITE_PUBLIC_ORIGIN，不要用虚拟域名生成分享链接。
  const shareOrigin = location.origin.includes('appassets')
    ? ((import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) || 'https://your-domain.example')
    : location.origin;
  const shareLink = (v: Video, ep: number) =>
    `${shareOrigin}/?v=${v.id}&ep=${Math.max(1, ep || 1)}`;

  const tabsVisible = stack.length === 0;
  // 播放页盖在首页视频上时，把首页自己的 UI 藏掉，只留播放页那套
  const ghostOpen = stack.some((o) => o.kind === 'player' && !!o.feed);
  /**
   * 首页那一屏到底算不算「在台前」：
   *  - 只有压在它上面的全是「借首页这屏当画面」的播放页时，画面必须继续播（否则全屏/透明播放页会黑）；
   *  - 换成别的播放页（自己取流的）、全屏、详情、搜索…一律算后台，首页那屏必须停住，不许出声。
   */
  const feedFront = stack.length === 0 || stack.every((o) => o.kind === 'player' && !!o.feed);
  const homeFront = tab === 'home' && feedFront;
  // 原生播放层在 WebView 下面：有播放页/全屏页时整页让位，透明区域才看得到画面
  const videoOpen =
    nativeMode && stack.some((o) => o.kind === 'player' || o.kind === 'landscape');

  return (
    <div
      className={`app${ghostOpen ? ' ghost-open' : ''}${videoOpen ? ' vid-open' : ''} tab-${tab}`}
    >
      <div
        className="panes"
        style={{
          transform: `translateX(-${TAB_ORDER.indexOf(tab) * 25}%)`,
        }}
      >
      <div className={tab === 'home' ? 'pane on' : 'pane'}>
        <HomePage
          onOpen={(v, ep, at) => openPlayer(v, ep, at, true)}
          onDetail={(id) => push({ kind: 'detail', id })}
          onComment={(v) => push({ kind: 'comments', id: v.id, title: v.title })}
          onShare={(v, ep) => push({ kind: 'share', v, ep })}
          onLandscape={(v, ep, at) => {
            // 同上：全屏页接管同一个原生播放器，不 stop、不重取流
            if (nativeMode) {
              prevPlayRef.current = engine.active;
              if (at && at > 1) engine.seek(at);
            }
            push({ kind: 'landscape', v, ep, at });
          }}
          onSearch={() => push({ kind: 'search' })}
          onToast={setToast}
          onDrawer={() => setDrawer(true)}
          refreshKey={homeRefresh}
          resumeKey={homeResume}
          suspend={ghostOpen}
          visible={homeFront}
          epSync={homeSync}
        />
      </div>
              <div className={tab === 'theater' ? 'pane on' : 'pane'}>
          {mounted.has('theater') && (
          <TheaterPage
            key={theaterSort}
            initialSort={theaterSort}
            onOpen={(v, ep) => openPlayer(v, ep)}
            onDetail={(id) => push({ kind: 'detail', id })}
            onSearch={() => push({ kind: 'search' })}
            onRank={() => setTab('rank')}
            onToast={setToast}
          />
          )}
        </div>
              <div className={tab === 'rank' ? 'pane on' : 'pane'}>
          {mounted.has('rank') && (
            <RankPage
              onOpen={(v, ep) => openPlayer(v, ep)}
              onDetail={(id) => push({ kind: 'detail', id })}
              onSearch={() => push({ kind: 'search' })}
              onBack={() => setTab('home')}
              onToast={setToast}
            />
          )}
        </div>
              <div className={tab === 'mine' ? 'pane on' : 'pane'}>
          {mounted.has('mine') && (
          <ProfilePage
            onOpen={(v, ep) => openPlayer(v, ep)}
            onDetail={(id) => push({ kind: 'detail', id })}
            onSearch={() => push({ kind: 'search' })}
            onToggleTheme={() =>
              patchSettings({ theme: theme === 'light' ? 'dark' : 'light' })
            }
            theme={theme}
            user={user}
            focusTab={mineTab}
            onTabChange={(t) => {
              setMineTab(t);
              const map: Record<string, string> = { 历史: 'hist', 收藏: 'fav', 追更: 'follow', 点赞: 'like' };
              if (map[t]) setSidePick(map[t]);
            }}
            onLogin={() => push({ kind: 'login' })}
            onLogout={async () => { await auth.logout(); setUser(null); resetMarks(); setToast('已退出登录'); }}
            onToast={setToast}
            onDrawer={() => setDrawer(true)}
          />
          )}
        </div>

      </div>

      {tabsVisible && !isDesktop && (
        <TabBar
          active={tab}
          // 首页浮在视频上始终深色；其余页面跟着亮/暗主题走
          dark={tab === 'home' || theme === 'dark'}
          onChange={(k) => {
            if (k === tab && k === 'home') {
              setHomeRefresh((n) => n + 1);
              setToast('已为你重新推荐');
              return;
            }
            setTab(k);
          }}
        />
      )}

      {isDesktop && (
        <DesktopSidebar
          activeKey={sidePick}
          user={user}
          collapsed={sideCollapsed}
          notices={notices}
          noticeUnread={noticeUnread}
          onOpenNotices={() => {
            setNoticeOpen(true);
            if (notices[0]) {
              markRead(notices[0].id);
              setNoticeReadPing((n) => n + 1);
            }
          }}
          onCheckUpdate={() => void manualCheck()}
          onToggleCollapse={() => {
            const next = !sideCollapsed;
            setSideCollapsed(next);
            store.set('sideCollapsed', next);
          }}
          onChange={(k) => {
            setStack([]);
            setTab(k);
            if (k === 'theater') setTheaterSort('default');
            setSidePick(k === 'home' ? 'rec' : k === 'rank' ? 'rank' : k === 'mine' ? 'hist' : 'find');
            if (k === 'mine') setMineTab('历史');
          }}
          onMine={(t) => {
            setStack([]);
            setMineTab(t);
            const map: Record<MineTab, string> = { 历史: 'hist', 收藏: 'fav', 追更: 'follow', 点赞: 'like' };
            setSidePick(map[t]);
            setTab('mine');
          }}
          onNew={() => {
            // 侧栏「新剧」= 直接看最新上架，不是找剧那套筛选
            setTheaterSort('new');
            setSidePick('new');
            setTab('theater');
          }}
          onToast={setToast}
          onSettings={() => setSettingsOpen(true)}
          onLogin={() => push({ kind: 'login' })}
          onLogout={async () => {
            await auth.logout();
            setUser(null);
            setToast('已退出登录');
          }}
        />
      )}

      {isDesktop && (
        <SettingsSheet
          open={settingsOpen}
          settings={settings}
          onChange={patchSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {stack.map((o, i) => {
        const z = 60 + i * 5;
        // 上面压着播放页时，这一层必须整块收起来：原生画面在 WebView 底下，
        // 只要这层还有内容，就会从视频黑边/舞台里透出来（看着像两个页面叠在一起）
        const covered =
          nativeMode && stack.slice(i + 1).some((x) => x.kind === 'player' || x.kind === 'landscape');
        if (o.kind === 'detail') {
          return (
            <div className={`ov${covered ? ' ov-hide' : ''}`} key={`d${i}`} style={{ zIndex: z }}>
              <DetailPage
                id={o.id}
                onBack={back}
                onPlay={(v, ep) => openPlayer(v, ep)}
                onComment={(v) => push({ kind: 'comments', id: v.id, title: v.title })}
                onShare={(v, ep) => push({ kind: 'share', v, ep })}
                onToast={setToast}
              />
            </div>
          );
        }
        if (o.kind === 'download') {
          return (
            <div className="ov" key={`dl${i}`} style={{ zIndex: z }}>
              <DownloadPage onBack={back} />
            </div>
          );
        }
        if (o.kind === 'login') {
          return (
            <div className="ov ov-clear" key={`l${i}`} style={{ zIndex: z }}>
              <LoginSheet
                onClose={back}
                onDone={(u) => {
                  setUser(u);
                  resetMarks();
                  back();
                  setToast(`欢迎，${u.nickname || u.username}`);
                }}
              />
            </div>
          );
        }
        if (o.kind === 'search') {
          return (
            <div className={`ov${covered ? ' ov-hide' : ''}`} key={`q${i}`} style={{ zIndex: z }}>
              <SearchPage
                initialQuery={o.q || ''}
                onBack={back}
                onOpen={(v, ep) => openPlayer(v, ep)}
                onDetail={(id) => push({ kind: 'detail', id })}
                onToast={setToast}
              />
            </div>
          );
        }
        if (o.kind === 'landscape') {
          return (
            <div className={`ov${nativeMode ? ' ov-land' : ''}`} key={`land${i}`} style={{ zIndex: z }}>
              <LandscapePlayer
                video={o.v}
                ep={o.ep}
                startAt={o.at}
                host={stageVideoRef.current}
                onClose={(at, ep2) => {
                  back();
                  // 全屏里换了集：把集数交回下面那一层，别让它还停在上一个集
                  if (!nativeMode && ep2 && ep2 !== o.ep) {
                    setPlayerSync({ ep: ep2, at: at || 0, k: Date.now() });
                  }
                  // 全屏用的是同一个原生播放器：退出时把画面交还给下面那一层，
                  // 只在同一条流上挪矩形 + 对齐位置，绝不重新取流
                  if (nativeMode) {
                    const prev: any = prevPlayRef.current;
                    if (prev && prev.host) prev.claim(prev.fit, at && at > 1 ? at : undefined);
                    else engine.reclaim();
                    engine.setVisible(true);
                    if (at && at > 1) engine.seek(at);
                    engine.play();
                    // 这一层收起后矩形才归位：稍后再同步一次，防一帧黑
                    window.setTimeout(() => engine.syncRect(), 120);
                  }
                }}
                onDetail={(id) => push({ kind: 'detail', id })}
                onComment={(v) => push({ kind: 'comments', id: v.id, title: v.title })}
                onShare={(v, ep) => push({ kind: 'share', v, ep })}
                onToast={setToast}
              />
            </div>
          );
        }
        if (o.kind === 'player') {
          return (
            <div
              className={`ov${o.feed ? ' ov-ghost' : ''}${nativeMode ? ' ov-video' : ''}${
                covered ? ' ov-hide' : ''
              }`}
              key={`p${i}`}
              style={{ zIndex: z }}
            >
              <EpisodePlayer
                video={o.v}
                ep={o.ep}
                startAt={o.at}
                feed={o.feed}
                suspend={
                  !nativeMode &&
                  i < stack.length - 1 &&
                  // 上面压着的是全屏页：它借用的正是这一层的 <video>，这里不能把它按停
                  stack[i + 1]?.kind !== 'landscape'
                }
                onStageVideo={(el) => {
                  stageVideoRef.current = el;
                }}
                sync={playerSync}
                onExit={(ep) => {
                  if (o.feed) pendingHomeSync.current = { vid: o.v.id, ep };
                }}
                onClose={back}
                onDetail={(id) => push({ kind: 'detail', id })}
                onComment={(v) => push({ kind: 'comments', id: v.id, title: v.title })}
                onShare={(v, ep) => push({ kind: 'share', v, ep })}
                onToast={setToast}
                onLandscape={(v, ep, at) => {
                  // 全屏页会用同一个原生播放器接管画面：这里只记下「原来是哪个壳占着」，
                  // 退出全屏时原样还回去（同一条流，不重新取、不传进度）
                  if (nativeMode) {
                    prevPlayRef.current = engine.active;
                    if (at && at > 1) engine.seek(at);
                  }
                  push({ kind: 'landscape', v, ep, at });
                }}
              />
            </div>
          );
        }
        if (o.kind === 'comments') {
          return (
            <div className="ov ov-clear" key={`c${i}`} style={{ zIndex: z }}>
              <CommentSheet
                videoId={o.id}
                title={o.title}
                onClose={back}
                onToast={setToast}
              />
            </div>
          );
        }
        return (
          <div className="ov ov-clear" key={`s${i}`} style={{ zIndex: z }}>
            <ShareSheet
              link={shareLink(o.v, o.ep)}
              title={o.v.title}
              onClose={back}
              onToast={setToast}
              onDownload={() => push({ kind: 'download' })}
            />
          </div>
        );
      })}

      {drawer && (
        <Drawer
          notices={notices}
          noticeUnread={noticeUnread}
          onOpenNotices={() => {
            setDrawer(false);
            setNoticeOpen(true);
          }}
          onClose={() => setDrawer(false)}
          onPick={(label) => {
            setDrawer(false);
            if (label === '检查更新') {
              void manualCheck();
              return;
            }
            setToast(`${label}：等待接入`);
          }}
        />
      )}

      {/* 有版本更新 → 弹「更新卡片」（软件内下载 + 进度 + 装完进安装页），不再用顶部细条 */}
      {updCard && (
        <UpdateCard
          info={updCard}
          notes={notesForVersion(updCard.version)}
          onClose={() => setUpdCard(null)}
        />
      )}

      {noticeOpen && (
        <NoticeSheet
          items={notices}
          current={notices[0]?.id}
          onClose={() => setNoticeOpen(false)}
        />
      )}

      {/* 上线提示只在首页露面：看剧/看详情时绝不盖上来打扰 */}
      {fresh && tab === 'home' && stack.length === 0 && (
        <div className="freshbar">
          <span>上游上新：{fresh.latest_title || `共 ${fresh.total} 部`}</span>
          <button
            type="button"
            onClick={() => {
              accept();
              setHomeRefresh((n) => n + 1);
              setToast('已刷新内容');
            }}
          >
            刷新
          </button>
          <button type="button" className="upx" onClick={dismiss}>
            ✕
          </button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      {api.mockMode && tab === 'home' && stack.length === 0 && (
        <div className="mode-hint">演示数据</div>
      )}
    </div>
  );
}
