/**
 * 长按画面 = 临时 2 倍速（竖屏播放页 / 横屏播放器 / PC 共用同一套节奏）。
 *
 * 规则：
 *  - 按住 480ms 且几乎没移动 → 进入快放，松手恢复成用户自己选的那一档倍速
 *  - 中途位移超过 12px（要滑动了）→ 直接取消，把手势让给别的交互
 *  - 松手时返回 true，调用方据此屏蔽「抬手那一下的点击」
 */
import { useCallback, useRef } from 'react';

export const BOOST_RATE = 2;

export function useLongPressBoost(opts: {
  /** 用户当前选的倍速（长按结束后恢复它） */
  speed: () => number;
  /** 立刻作用到播放器上 */
  apply: (rate: number) => void;
  /** 进入 / 退出快放，用来开关浮层提示 */
  onToggle?: (on: boolean) => void;
  delay?: number;
}) {
  const speedRef = useRef(opts.speed);
  const applyRef = useRef(opts.apply);
  const toggleRef = useRef(opts.onToggle);
  speedRef.current = opts.speed;
  applyRef.current = opts.apply;
  toggleRef.current = opts.onToggle;

  const timer = useRef(0);
  const inBoost = useRef(false);
  const delay = opts.delay ?? 480;

  const stopTimer = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = 0;
    }
  };

  const down = useCallback(() => {
    stopTimer();
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      if (inBoost.current) return;
      inBoost.current = true;
      applyRef.current(BOOST_RATE);
      toggleRef.current?.(true);
    }, delay);
  }, [delay]);

  const move = useCallback((dx: number, dy: number) => {
    if (inBoost.current) return; // 已经进入快放，移动不该把它撤掉
    if (Math.hypot(dx, dy) > 12) stopTimer();
  }, []);

  /** 松手；返回 true 表示刚刚正在长按快放 */
  const up = useCallback((): boolean => {
    stopTimer();
    if (!inBoost.current) return false;
    inBoost.current = false;
    applyRef.current(speedRef.current());
    toggleRef.current?.(false);
    return true;
  }, []);

  const cancel = up;
  return { down, move, up, cancel };
}
