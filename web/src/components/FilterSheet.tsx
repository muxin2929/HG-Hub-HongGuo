import { useEffect, useState } from 'react';
import { api } from '../data/api';
import type { Category } from '../data/types';
import { Icon } from './Icons';

export type SortKey = 'default' | 'new' | 'hot' | 'episodes';

export const SORT_LABEL: Record<SortKey, string> = {
  default: '综合排序',
  new: '最新上线',
  hot: '最多热度',
  episodes: '集数最多',
};

/** 剧场页的「筛选 / 排序」面板。分类走上游 cate_id，排序用上游 sort=new + 客户端补两种。 */
export function FilterSheet({
  cate,
  sort,
  focus,
  onApply,
  onClose,
}: {
  cate: string;
  sort: SortKey;
  focus: 'filter' | 'sort';
  onApply: (cate: string, sort: SortKey) => void;
  onClose: () => void;
}) {
  const [cats, setCats] = useState<Category[]>([]);
  const [curCate, setCurCate] = useState(cate);
  const [curSort, setCurSort] = useState<SortKey>(sort);

  useEffect(() => {
    api
      .categories()
      .then(setCats)
      // 拉失败就保留已有列表（别把分类整块清空，那会让人以为分类没了）
      .catch(() => undefined);
  }, []);

  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <div className="filtersheet">
        <div className="fs-head">
          <span>筛选 · 排序</span>
          <button type="button" className="csh-close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className={`fs-sec${focus === 'filter' ? ' focus' : ''}`}>
          <div className="fs-title">分类</div>
          <div className="fs-chips">
            <button
              type="button"
              className={`fs-chip${curCate === '' ? ' on' : ''}`}
              onClick={() => setCurCate('')}
            >
              全部
            </button>
            {cats.map((c) => (
              <button
                key={String(c.id)}
                type="button"
                className={`fs-chip${String(curCate) === String(c.id) ? ' on' : ''}`}
                onClick={() => setCurCate(String(c.id))}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div className={`fs-sec${focus === 'sort' ? ' focus' : ''}`}>
          <div className="fs-title">排序</div>
          <div className="fs-chips">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`fs-chip${curSort === k ? ' on' : ''}`}
                onClick={() => setCurSort(k)}
              >
                {SORT_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="fs-actions">
          <button
            type="button"
            className="fs-reset"
            onClick={() => {
              setCurCate('');
              setCurSort('default');
            }}
          >
            重置
          </button>
          <button
            type="button"
            className="fs-ok"
            onClick={() => {
              onApply(curCate, curSort);
              onClose();
            }}
          >
            确定
          </button>
        </div>
      </div>
    </>
  );
}
