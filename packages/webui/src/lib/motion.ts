/**
 * 共用的动效预设（`motion/react` 的 variants）。数值与 `tokens.css` 的动效令牌对齐。
 */

import type { TargetAndTransition, Variants } from 'motion/react';

/** 默认缓动，与 `--ease-out` 一致。 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** 首屏进场：容器负责错峰，子元素各自「上浮 + 去模糊」。 */
export const enterStagger: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.06 } },
};

export const enterRise: Variants = {
  hidden: { opacity: 0, y: 14, filter: 'blur(6px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.7, ease: EASE_OUT } },
};

/** 标志类元素：缩放弹入。 */
export const enterPop: Variants = {
  hidden: { opacity: 0, scale: 0.72, filter: 'blur(8px)' },
  shown: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: { type: 'spring', bounce: 0.38, duration: 0.85 },
  },
};

/** 整屏离场（切到下一屏时）。 */
export const screenExit: TargetAndTransition = {
  opacity: 0,
  scale: 0.985,
  filter: 'blur(8px)',
  transition: { duration: 0.38, ease: EASE_OUT },
};
