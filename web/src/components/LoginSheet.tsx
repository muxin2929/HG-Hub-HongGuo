import { useState } from 'react';
import { auth, type User } from '../core/auth';
import { Icon } from './Icons';

/** 登录 / 注册面板（自建账号，不碰上游）。 */
export function LoginSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (u: User) => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const friendly = (msg: string) => {
    if (/HTTP 4\d\d/.test(msg) || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '网络异常，请检查网络后重试';
    }
    return msg || '操作失败，请重试';
  };

  const submit = async () => {
    if (busy) return;
    const name = username.trim();
    const pass = password;
    if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) {
      setErr('账号需 3-24 位，只能包含字母、数字、下划线');
      return;
    }
    if (pass.length < 6) {
      setErr('密码至少 6 位');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const u =
        mode === 'login'
          ? await auth.login(name, pass)
          : await auth.register(name, pass, nickname.trim());
      if (!u || !u.id) {
        setErr('登录状态异常，请重试');
        return;
      }
      onDone(u);
    } catch (e: any) {
      setErr(friendly(String(e?.message || e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className="loginsheet">
        <div className="lg-head">
          <span>{mode === 'login' ? '登录' : '注册'}</span>
          <button type="button" className="csh-close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="lg-tabs">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'on' : ''}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        <input
          className="lg-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="账号（3-24 位）"
          autoCapitalize="none"
          autoCorrect="off"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <input
          className="lg-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码（至少 6 位）"
          type="password"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        {mode === 'register' && (
          <input
            className="lg-input"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="昵称（可选）"
          />
        )}
        {err && <div className="lg-err">{err}</div>}

        <button type="button" className="lg-submit" disabled={busy} onClick={submit}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <div className="lg-tip">
          账号只存在你自己的服务器（SQLite），收藏/历史/续播/评论会同步到这里，与上游账号无关。
        </div>
      </div>
    </>
  );
}
