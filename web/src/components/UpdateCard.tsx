import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { downloadUpdate, installUpdate, subscribeUpdate, updateChannel } from '../core/appUpdate';
import type { UpdateInfo } from '../core/update';

type Phase = 'idle' | 'downloading' | 'done' | 'browser' | 'error';

function sizeText(n?: number): string {
  if (!n || !Number.isFinite(n)) return '';
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * 更新卡片（做成一张小广告的样子）：版本号 + 这次更新了什么 + 一个更新按钮。
 * 点按钮后原地变进度条（软件内下载），下完点一次就进安装：
 *  - 手机：拉起系统安装界面，装完不自动打开
 *  - 桌面：重启后自动装好并打开
 */
export function UpdateCard({
  info,
  notes,
  onClose,
}: {
  info: UpdateInfo;
  notes: string[];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pct, setPct] = useState(0);
  const [bps, setBps] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState('');
  const ch = updateChannel();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const off = subscribeUpdate((e) => {
      if (!alive.current) return;
      if (e.phase === 'progress') {
        setPct(Math.max(0, Math.min(100, e.pct ?? 0)));
        if (e.bps) setBps(e.bps);
        if (e.total) setTotal(e.total);
      } else if (e.phase === 'done') {
        setPct(100);
        setPhase('done');
      } else if (e.phase === 'error') {
        setMsg(e.msg || '下载失败');
        setPhase('error');
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, []);

  const start = async () => {
    setPhase('downloading');
    setPct(0);
    setMsg('');
    try {
      const mode = await downloadUpdate(info);
      if (mode === 'browser') setPhase('browser');
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
      setPhase('error');
    }
  };

  return (
    <div className="updmask" onClick={onClose}>
      <div className="updcard" onClick={(e) => e.stopPropagation()}>
        <div className="updhero">
          <button type="button" className="updclose" onClick={onClose} aria-label="关闭">
            ✕
          </button>
          <span className="updkicker">新版本</span>
          <b className="updver">v{info.version}</b>
          <span className="updsub">
            {ch === 'android' ? '装好就是最新版，不影响正在看的进度' : '重启后自动完成更新'}
          </span>
        </div>

        <div className="updbody">
          {(notes.length ? notes : ['播放与体验问题修复']).slice(0, 5).map((t, i) => (
            <div className="updline" key={i}>
              <span className="upddot" />
              <span>{t}</span>
            </div>
          ))}
        </div>

        {phase === 'idle' && (
          <div className="updacts">
            <button type="button" className="updgo" onClick={start}>
              立即更新
            </button>
            <button type="button" className="updghost" onClick={onClose}>
              稍后
            </button>
          </div>
        )}

        {phase === 'downloading' && (
          <div className="updprog">
            <div className="updbar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="updmeta">
              <span>{pct.toFixed(0)}%</span>
              <span>
                {bps > 0 ? `${(bps / 1024 / 1024).toFixed(1)} MB/s` : '下载中…'}
                {total ? ` · ${sizeText(total)}` : ''}
              </span>
            </div>
            <span className="updnote">可以继续看，下载完再点安装就行</span>
          </div>
        )}

        {phase === 'done' && (
          <div className="updacts">
            <button
              type="button"
              className="updgo"
              onClick={() => {
                installUpdate();
                onClose();
              }}
            >
              {ch === 'android' ? '立即安装' : '重启并安装'}
            </button>
            <button type="button" className="updghost" onClick={onClose}>
              稍后
            </button>
          </div>
        )}

        {phase === 'browser' && (
          <div className="updprog">
            <span className="updnote">已交给系统下载，装好后重新打开即可</span>
            <button type="button" className="updghost wide" onClick={onClose}>
              知道了
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="updprog">
            <span className="updnote err">{msg || '下载失败，请稍后重试'}</span>
            <div className="updacts">
              <button type="button" className="updgo" onClick={start}>
                重试
              </button>
              <button type="button" className="updghost" onClick={onClose}>
                稍后
              </button>
            </div>
          </div>
        )}

        {ch === 'android' && phase === 'done' && (
          <div className="updtip">
            <Icon name="info" size={13} strokeWidth={1.8} />
            <span>安装界面由系统弹出，装完不会自动打开当前应用</span>
          </div>
        )}
      </div>
    </div>
  );
}
