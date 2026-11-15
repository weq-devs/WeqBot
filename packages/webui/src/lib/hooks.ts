/** 控制台共用的数据钩子：订阅 / 轮询 / 防抖。 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 订阅一个外部数据源。
 *
 * `subscribe` 必须稳定（用 `useCallback` 包住），否则每次渲染都会重订阅。
 * 返回 `reload()` 让页面可以手动刷新。
 */
export function useSubscription<T>(
  subscribe: (onData: (value: T) => void, onError: (error: unknown) => void) => () => void,
  deps: unknown[],
): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 由调用方声明
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    const off = subscribeRef.current(
      (value) => {
        if (!active) return;
        setData(value);
        setLoading(false);
      },
      (cause) => {
        if (!active) return;
        setError(cause);
        setLoading(false);
      },
    );
    return () => {
      active = false;
      off();
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/** 按间隔轮询一个异步函数（页面不在前台时暂停）。 */
export function usePolling<T>(
  load: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): { data: T | undefined; error: unknown; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 由调用方声明
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (!active) return;
      if (document.visibilityState === 'visible') {
        try {
          const value = await loadRef.current();
          if (active) {
            setData(value);
            setError(undefined);
          }
        } catch (cause) {
          if (active) setError(cause);
        }
      }
      if (active) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, nonce, intervalMs]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, reload };
}
