import { useEffect, useState } from 'react';

/** 判断是否桌面布局（和 CSS 断点保持一致） */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setDesktop(m.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);
  return desktop;
}
