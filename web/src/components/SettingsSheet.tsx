import type { AppSettings, CloseBehavior, ThemeMode } from '../core/settings';
import { Icon } from './Icons';

const THEME_OPTS: Array<{ v: ThemeMode; t: string }> = [
  { v: 'light', t: '亮色' },
  { v: 'dark', t: '暗色' },
  { v: 'auto', t: '跟随系统' },
];

const CLOSE_OPTS: Array<{ v: CloseBehavior; t: string }> = [
  { v: 'tray', t: '挂到托盘' },
  { v: 'quit', t: '直接退出' },
];

/** PC 端设置面板（手机端不出这个入口） */
export function SettingsSheet({
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="setwrap" onClick={onClose}>
      <div className="setcard" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <h2>设置</h2>
          <button type="button" className="set-x" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} strokeWidth={2.2} />
          </button>
        </div>

        <div className="set-row">
          <div className="set-label">
            <b>外观</b>
            <p>暗色时左侧导航一起变深，系统窗口标题栏也会跟着变</p>
          </div>
          <div className="set-seg">
            {THEME_OPTS.map((o) => (
              <button
                type="button"
                key={o.v}
                className={settings.theme === o.v ? 'on' : ''}
                onClick={() => onChange({ theme: o.v })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <div className="set-label">
            <b>关闭窗口时</b>
            <p>挂到托盘会保留运行，右下角图标双击即可回来</p>
          </div>
          <div className="set-seg">
            {CLOSE_OPTS.map((o) => (
              <button
                type="button"
                key={o.v}
                className={settings.closeBehavior === o.v ? 'on' : ''}
                onClick={() => onChange({ closeBehavior: o.v })}
              >
                {o.t}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
