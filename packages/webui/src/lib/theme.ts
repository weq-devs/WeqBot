/**
 * 深浅色主题：偏好（浅 / 深 / 跟随系统）存在 localStorage，生效靠
 * `<html data-theme>`。首帧前由 `public/theme-init.js` 先定一次，这里接管之后的切换。
 *
 * 切换时用 View Transition 从点击处圆形扩散；浏览器不支持、用户要求减少动效、
 * 或者切换前后实际颜色不变（例如「跟随系统」→ 同色的固定模式）时直接切。
 */

import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** 与 `public/theme-init.js` 共用的存储键。 */
const STORAGE_KEY = 'weqbot.theme';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const listeners = new Set<() => void>();

let preference: ThemePreference = readStoredPreference();

function readStoredPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function storePreference(value: ThemePreference): void {
  try {
    if (value === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 存不下就只在本次会话生效。
  }
}

export function resolveTheme(value: ThemePreference): ResolvedTheme {
  if (value === 'system') return darkQuery.matches ? 'dark' : 'light';
  return value;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 「跟随系统」时，系统切换深浅色要立刻反映到页面上。
darkQuery.addEventListener('change', () => {
  if (preference !== 'system') return;
  applyTheme();
  notify();
});

/**
 * 切换主题偏好。
 *
 * `origin` 是圆形扩散的圆心（视口坐标），一般传点击位置。
 */
export function setThemePreference(next: ThemePreference, origin?: { x: number; y: number }): void {
  if (next === preference) return;

  const changesColors = resolveTheme(next) !== resolveTheme(preference);
  const commit = () => {
    preference = next;
    storePreference(next);
    applyTheme();
    // 同步提交 React 更新，View Transition 拍「新」快照时分段控件已经在新位置。
    flushSync(notify);
  };

  if (
    !changesColors ||
    reducedMotionQuery.matches ||
    typeof document.startViewTransition !== 'function'
  ) {
    commit();
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  const transition = document.startViewTransition(commit);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 560,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {
      // 过渡被浏览器跳过（例如页面不可见）：主题已经切好，不需要补救。
    });
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}
