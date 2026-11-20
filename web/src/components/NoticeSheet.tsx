import { useState } from 'react';
import type { Notice } from '../core/notices';

/** 公告面板：左侧列表，选中看全文。侧边栏点「公告」打开这里。 */
export function NoticeSheet({
  items,
  current,
  onClose,
}: {
  items: Notice[];
  current?: string;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<string>(current || items[0]?.id || '');
  const cur = items.find((n) => n.id === sel) || items[0];

  return (
    <div className="ntmask" onClick={onClose}>
      <div className="ntsheet" onClick={(e) => e.stopPropagation()}>
        <div className="nthead">
          <b>公告</b>
          <button type="button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="ntlist">
          {items.length === 0 && <div className="ntempty">还没有公告</div>}
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`ntitem${n.id === (cur && cur.id) ? ' on' : ''}`}
              onClick={() => setSel(n.id)}
            >
              <span className="nttitle">
                {n.kind === 'release' && <i className="nttag">版本</i>}
                {n.title}
              </span>
              <span className="ntdate">{n.at || ''}</span>
            </button>
          ))}
        </div>
        {cur && (
          <div className="ntbody">
            <b>{cur.title}</b>
            {cur.at && <span className="ntwhen">{cur.at}</span>}
            <p>{cur.body || '暂无详细说明。'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
