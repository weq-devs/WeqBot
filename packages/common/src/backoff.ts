/**
 * 带抖动的指数退避。
 *
 * 重连用它，但**重连节奏的最终裁决在 native**（TS 只处理 native 报告的
 * `closed` / `reconnect` 事件）。这里的退避用于「重新 quickLogin」这种 TS 发起的动作。
 */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** 抖动比例 0..1，默认 0.2（±20%）。 */
  jitter?: number;
  /** 伪随机源，测试注入。 */
  random?: () => number;
}

export class Backoff {
  private attempt = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 1_000;
    this.maxMs = options.maxMs ?? 60_000;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  /** 下一次等待毫秒数，并把尝试次数 +1。 */
  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** this.attempt);
    this.attempt += 1;
    const spread = raw * this.jitter;
    return Math.max(0, Math.round(raw - spread + this.random() * spread * 2));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
