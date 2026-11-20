/**
 * 「先压缩顶部、压缩吃满之后内容才开始滚」的滚动接管。
 *
 * 原生滚动容器在顶部时，手指/滚轮的位移先折算成顶部压缩量（0..1），
 * 这个过程里容器的 scrollTop 一直是 0，所以下面的内容相对「顶栏 + 标签行」
 * 的位置完全不变；压缩到 1 之后，后续位移才真正滚内容。
 * 反向同理：滚回顶部后继续下拉，压缩量反向回弹。
 *
 * 只有顶部这些位移会被接管，滚动容器照旧是原生滚动（惯性、回弹都在）。
 */
export function bindCollapseScroll(
  body: HTMLElement,
  opts: {
    /** 可压缩的总像素（压缩量 0 → 1 对应滚多少像素） */
    span: number;
    /** 当前压缩进度 0..1 */
    getP: () => number;
    /** 写压缩进度 0..1 */
    setP: (p: number) => void;
  },
): () => void {
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const atTop = () => body.scrollTop <= 0.5;

  let lastY = 0;
  // 'none' = 本段手势交给原生滚动；'pull' = 本段手势自己算压缩 + 平推
  let mode: 'none' | 'pull' = 'none';
  let sentinel = 0; // 平推模式下自增，避免原生滚动与手动 scrollTop 抢

  const apply = (p: number) => {
    const next = clamp01(p);
    opts.setP(next);
    return next;
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    lastY = t.clientY;
    mode = atTop() ? 'pull' : 'none';
  };

  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const dy = lastY - t.clientY; // 手指上滑（想看下面）= 正
    lastY = t.clientY;
    if (!atTop()) {
      if (mode === 'pull' && body.scrollTop > 0) mode = 'none';
      return;
    }

    const p = opts.getP();
    if (dy > 0 && p < 1) {
      e.preventDefault();
      mode = 'pull';
      const np = apply(p + dy / opts.span);
      const rest = dy - (np - p) * opts.span;
      if (rest > 0.5 && np >= 1) body.scrollTop += rest;
      return;
    }
    if (dy < 0 && p > 0) {
      e.preventDefault();
      mode = 'pull';
      apply(p + dy / opts.span);
      return;
    }
    if (mode === 'pull') {
      e.preventDefault();
      sentinel += 1;
      body.scrollTop = Math.max(0, body.scrollTop + dy);
    }
  };

  const onTouchEnd = () => {
    mode = 'none';
  };

  const onWheel = (e: WheelEvent) => {
    if (!atTop()) return;
    const p = opts.getP();
    const dy = e.deltaY;
    if (dy > 0 && p < 1) {
      e.preventDefault();
      const np = apply(p + dy / opts.span);
      const rest = dy - (np - p) * opts.span;
      if (rest > 0.5 && np >= 1) body.scrollTop += rest;
      return;
    }
    if (dy < 0 && p > 0) {
      e.preventDefault();
      apply(p + dy / opts.span);
    }
  };

  body.addEventListener('touchstart', onTouchStart, { passive: true });
  body.addEventListener('touchmove', onTouchMove, { passive: false });
  body.addEventListener('touchend', onTouchEnd, { passive: true });
  body.addEventListener('touchcancel', onTouchEnd, { passive: true });
  body.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    body.removeEventListener('touchstart', onTouchStart);
    body.removeEventListener('touchmove', onTouchMove);
    body.removeEventListener('touchend', onTouchEnd);
    body.removeEventListener('touchcancel', onTouchEnd);
    body.removeEventListener('wheel', onWheel);
  };
}
