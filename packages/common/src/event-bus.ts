/**
 * 类型安全的事件总线。
 *
 * 事件表用 `Record<string, unknown>` 描述，`emit` 的负载类型由键推导 ——
 * 新增事件只改事件表，不改总线实现。
 */

type AnyListener = (payload: unknown) => void;

export class TypedEventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

  /** 订阅；返回取消订阅函数（比 off 更好用，避免引用不一致）。 */
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyListener);
    return () => {
      set.delete(listener as AnyListener);
    };
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // 复制一份：监听器里调用 off() 不应影响本轮派发。
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch {
        // 单个订阅者抛错不能打断其它订阅者。错误归属由订阅者自己记日志。
      }
    }
  }

  /** 销毁：丢掉所有订阅（bot 停止时调用，防止宿主泄漏监听）。 */
  clear(): void {
    this.listeners.clear();
  }
}
