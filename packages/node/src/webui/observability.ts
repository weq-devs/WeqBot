/**
 * WebUI 的三条观测流（W7）：运行日志 / action 调用 / 推送事件。
 *
 * 三条都是**进程内存里的有界环形缓冲**，不落盘（硬约束 13 的判据：这是运行期
 * 观测，不给任何 action 当数据源）。满了就丢最老的 —— 宁可少几行日志，也不要
 * 一个长跑进程把内存吃光。
 *
 * 脱敏在这里统一做：日志字段与 action 参数里出现 skey / pskey / cookie /
 * clientKey / a1 / a2 / d2 / d2Key / secToken / 访问令牌时替换成 `***`。
 * 这是**字符串级**兜底，不假装覆盖所有编码变体；真正的第一道防线是这些值
 * 本来就不该进日志。
 */

import type { LogLevel, LogRecord } from '@weqbot/common';

const DEFAULT_LOG_CAPACITY = 2000;
const DEFAULT_ACTION_CAPACITY = 1000;
const DEFAULT_EVENT_CAPACITY = 1000;

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface ActionCallEntry {
  ts: number;
  action: string;
  /** 脱敏后的参数（只保留结构，敏感值替换成 `***`）。 */
  params: Record<string, unknown>;
  retcode: number;
  status: 'ok' | 'failed';
  latencyMs: number;
  transport: 'ws' | 'http' | 'webui';
  /** 客户端标识；WebUI 是 `webui`，网络层给连接名或远端地址。 */
  client: string;
}

export interface PushEventEntry {
  ts: number;
  /** 语义类型：`message` / `notice` / `request` / `meta` / `state` / `other`。 */
  type: string;
  /** 细分类：消息的 scene、通知的 kind、状态的迁移名等。 */
  kind: string;
  peer?: string;
  summary: string;
}

export interface ActionStats {
  total: number;
  ok: number;
  failed: number;
  /** 按 action 名计数，降序。 */
  byAction: Array<{ action: string; count: number; failed: number }>;
  /** 失败按 retcode 计数，降序。 */
  byRetcode: Array<{ retcode: number; count: number }>;
  latency: { p50: number; p95: number; max: number };
  transports: Record<string, number>;
}

/** 有界环形缓冲；`push` 是 O(1)，超出容量丢最老的。 */
class Ring<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  /** 最老的在前；`since` 是「只要 ts 大于它」的过滤（增量拉取用）。 */
  list(since?: number): T[] {
    if (since === undefined) return [...this.items];
    return this.items.filter((item) => {
      const ts = (item as { ts?: number }).ts;
      return ts !== undefined && ts > since;
    });
  }

  get size(): number {
    return this.items.length;
  }
}

const SENSITIVE_KEYS = [
  'a1',
  'a2',
  'd1',
  'd2',
  'd2key',
  'skey',
  'pskey',
  'p_skey',
  'cookie',
  'cookies',
  'clientkey',
  'sectoken',
  'accesstoken',
  'token',
  'authorization',
  'password',
];

const REDACTED = '***';

/** 键名是否敏感（大小写 / 下划线不敏感）。 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEYS.some((sensitive) => normalized === sensitive);
}

/**
 * 深拷贝并脱敏。数组与原样标量保持形状，只替换敏感值。
 *
 * `depth` 上限防循环引用（日志字段里偶尔会有请求对象）。
 */
export function redact(value: unknown, depth = 0, keyHint?: string): unknown {
  if (depth > 6) return '[depth]';
  if (keyHint !== undefined && isSensitiveKey(keyHint)) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redact(item, depth + 1, key);
  }
  return out;
}

/** 从一条语义事件里抽一行摘要；不认识的类型给空串（不抛错）。 */
export function summarizeEvent(event: unknown): PushEventEntry | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'other';
  const ts = Date.now();

  if (type === 'message') {
    const message = record.message as Record<string, unknown> | undefined;
    if (!message) return { ts, type, kind: 'unknown', summary: '' };
    const scene = String(message.scene ?? 'unknown');
    const peer = (message.peer as Record<string, unknown> | undefined)?.id;
    const sender = (message.sender as Record<string, unknown> | undefined)?.id;
    const elements = Array.isArray(message.elements) ? message.elements : [];
    const text = elements
      .map((element) => {
        const item = element as Record<string, unknown>;
        return item.type === 'text' && typeof item.text === 'string'
          ? item.text
          : `[${String(item.type)}]`;
      })
      .join('')
      .slice(0, 120);
    return {
      ts,
      type,
      kind: scene,
      ...(peer !== undefined ? { peer: String(peer) } : {}),
      summary: `${String(sender ?? '?')} → ${String(peer ?? '?')}: ${text}`,
    };
  }

  if (type === 'notice' || type === 'request') {
    const kind = typeof record.kind === 'string' ? record.kind : type;
    const sender = (record.sender as Record<string, unknown> | undefined)?.id;
    return {
      ts,
      type,
      kind,
      ...(sender !== undefined ? { peer: String(sender) } : {}),
      summary: kind,
    };
  }

  if (type === 'state') {
    const to = typeof record.to === 'string' ? record.to : '';
    return { ts, type, kind: to || 'state', summary: to };
  }

  if (type === 'heartbeat') {
    return { ts, type, kind: 'heartbeat', summary: `rtt=${String(record.rttMs ?? '?')}ms` };
  }

  return { ts, type, kind: type, summary: '' };
}

/**
 * 三条流的容器。单个实例挂在 console 运行时上，路由与埋点共用。
 */
export class Observability {
  readonly logs = new Ring<LogEntry>(DEFAULT_LOG_CAPACITY);
  readonly actions = new Ring<ActionCallEntry>(DEFAULT_ACTION_CAPACITY);
  readonly events = new Ring<PushEventEntry>(DEFAULT_EVENT_CAPACITY);
  private readonly listeners = new Set<(stream: StreamName, entry: unknown) => void>();

  /** 运行日志的 `LogSink`。字段里的敏感值在写入前就脱敏。 */
  readonly logSink = (record: LogRecord): void => {
    const entry: LogEntry = {
      ts: record.ts,
      level: record.level,
      scope: record.scope,
      msg: record.msg,
      ...(record.fields ? { fields: redact(record.fields) as Record<string, unknown> } : {}),
    };
    this.logs.push(entry);
    this.notify('logs', entry);
  };

  recordAction(entry: Omit<ActionCallEntry, 'params'> & { params: Record<string, unknown> }): void {
    const stored: ActionCallEntry = {
      ...entry,
      params: redact(entry.params) as Record<string, unknown>,
    };
    this.actions.push(stored);
    this.notify('actions', stored);
  }

  recordEvent(event: unknown): void {
    const entry = summarizeEvent(event);
    if (!entry) return;
    this.events.push(entry);
    this.notify('events', entry);
  }

  /** SSE 订阅；返回取消函数。 */
  subscribe(listener: (stream: StreamName, entry: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(stream: StreamName, entry: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(stream, entry);
      } catch {
        // 单个订阅者出错不影响其它订阅者。
      }
    }
  }

  stats(): ActionStats {
    const items = this.actions.list();
    const total = items.length;
    const ok = items.filter((item) => item.status === 'ok').length;
    const failed = total - ok;

    const byActionMap = new Map<string, { count: number; failed: number }>();
    const byRetcodeMap = new Map<number, number>();
    const transports: Record<string, number> = {};
    for (const item of items) {
      const entry = byActionMap.get(item.action) ?? { count: 0, failed: 0 };
      entry.count += 1;
      if (item.status === 'failed') entry.failed += 1;
      byActionMap.set(item.action, entry);
      if (item.status === 'failed') {
        byRetcodeMap.set(item.retcode, (byRetcodeMap.get(item.retcode) ?? 0) + 1);
      }
      transports[item.transport] = (transports[item.transport] ?? 0) + 1;
    }

    const latencies = items.map((item) => item.latencyMs).sort((a, b) => a - b);
    return {
      total,
      ok,
      failed,
      byAction: [...byActionMap.entries()]
        .map(([action, value]) => ({ action, ...value }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      byRetcode: [...byRetcodeMap.entries()]
        .map(([retcode, count]) => ({ retcode, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      latency: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
      },
      transports,
    };
  }
}

export type StreamName = 'logs' | 'actions' | 'events';

/** 最近邻分位数：`[1,2,3,4]` 的 p50 取下标 2（向上取整再减一）。 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

export { REDACTED };
