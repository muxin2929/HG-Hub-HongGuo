import { api, coverUrl } from '../data/api';

let done = false;

function preload(src: string) {
  if (!src) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

/**
 * 开屏那 1 秒多别浪费：首页/剧场/榜单/搜索要用到的接口和封面先热一遍。
 * 图片缓存是跨页面复用的，同一部剧的封面在首页、剧场、榜单、我的里都长一样，
 * 预热一次后面几页就不用再等图。只跑一次，失败静默。
 */
export function warmupContent() {
  if (done) return;
  done = true;
  const quiet = <T>(p: Promise<T>) => void p.catch(() => undefined);

  quiet(api.catalogMeta());
  quiet(api.hotWords());
  // 榜单默认打开的是「漫剧 · 推荐榜」，和 RankPage 的 CATE/TYPE_OF 对齐
  quiet(
    api.ranksDaily(25, 'recommend', 24).then((r) => {
      r.items.slice(0, 12).forEach((v: any) => preload(coverUrl(v.cover)));
    }),
  );
  // 剧场第一屏（默认排序）与 AI 剧第一屏
  quiet(
    api.videos(1, undefined, 'hot').then((p) => {
      p.items.slice(0, 10).forEach((v: any) => preload(coverUrl(v.cover)));
    }),
  );
  quiet(
    api.videos(1, 24).then((p) => {
      p.items.slice(0, 8).forEach((v: any) => preload(coverUrl(v.cover)));
    }),
  );
}

