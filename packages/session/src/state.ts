/**
 * 会话状态机。
 *
 * 为什么要有它：mode2 的每一步都可能失败，而且失败后的**正确动作不同** ——
 * 凭据错要停，网络断要重登，注册被拒要退避。把「当前在哪一步」显式建模，
 * 比散落的 boolean 好排查，也方便 WeQ 的 UI 直接显示进度。
 *
 * 状态迁移不允许「任意跳转」：只能沿 {@link TRANSITIONS} 走，跳步会抛错。
 * 唯一的例外是 `closed`：任何状态都能一步关掉。
 */

export type SessionState =
  /** 还没开始。 */
  | 'idle'
  /** 环境预检：平台、QQ 安装路径、VM 可用性、native 能力。 */
  | 'preflight'
  /** `quickLogin(a1)` 换票。 */
  | 'logging-in'
  /** 拿到 a2/d2/d2Key，尚未注册。 */
  | 'logged-in'
  /** `openSession(mode 2)`：`SsoInfoSync` 注册 + 首屏同步 + 挂推送。 */
  | 'registering'
  /** 在线：心跳由 native 维持，事件从 sink 进来。 */
  | 'online'
  /** 掉线重试中（退避等待 / 重登）。 */
  | 'degraded'
  /** 终止态。 */
  | 'closed';

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  idle: ['preflight', 'closed'],
  preflight: ['logging-in', 'closed'],
  'logging-in': ['logged-in', 'degraded', 'closed'],
  'logged-in': ['registering', 'degraded', 'closed'],
  registering: ['online', 'degraded', 'closed'],
  online: ['degraded', 'closed'],
  // native 自己完成重连时（reconnected）不重走登录，直接回 online。
  degraded: ['logging-in', 'online', 'closed'],
  closed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly to: SessionState,
  ) {
    super(`非法状态迁移：${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export type StateChange = { from: SessionState; to: SessionState; at: number; detail?: string };

export class SessionStateMachine {
  private current: SessionState = 'idle';
  private readonly listeners = new Set<(change: StateChange) => void>();

  get state(): SessionState {
    return this.current;
  }

  get isTerminal(): boolean {
    return this.current === 'closed';
  }

  /** 订阅状态变化；返回取消订阅函数。 */
  onChange(listener: (change: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transition(to: SessionState, detail?: string): StateChange {
    const from = this.current;
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
    this.current = to;
    const change: StateChange = { from, to, at: Date.now(), ...(detail ? { detail } : {}) };
    for (const listener of [...this.listeners]) listener(change);
    return change;
  }

  /** 无条件关闭（用于清理路径，不校验当前状态）。 */
  forceClose(detail?: string): void {
    if (this.current === 'closed') return;
    this.transition('closed', detail);
  }
}
