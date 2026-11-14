/**
 * 适配层的内存消息缓存。
 *
 * 只做两件事：
 *   1. 把「收到的消息 → OneBot 事件」与「发出的消息 → 定位信息」按
 *      `message_id` 存起来，供 `get_msg` / `delete_msg` 反查；
 *   2. 有界（LRU），进程重启即失效 —— 与 SnowLuma 的 SQLite store 不同，
 *      WeqBot 不落盘（硬约束 4 的延伸：不持久化用户内容）。
 *
 * `message_id` 的分配在 `MessageIdMap` 里，这里只按 id 存元数据。
 */

import type { MessageMeta } from './types';

export interface StoredMessage {
  meta: MessageMeta;
  /** 完整的 OneBot 事件快照（`get_msg` 原样回它）。 */
  event: Record<string, unknown>;
  /** 入箱时间，LRU 用。 */
  at: number;
}

export class MessageStore {
  private readonly entries = new Map<number, StoredMessage>();

  constructor(private readonly capacity = 4096) {}

  put(messageId: number, entry: Omit<StoredMessage, 'at'>): void {
    this.entries.delete(messageId);
    this.entries.set(messageId, { ...entry, at: Date.now() });
    this.evict();
  }

  get(messageId: number): StoredMessage | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    // LRU：命中后移到队尾。
    this.entries.delete(messageId);
    this.entries.set(messageId, entry);
    return entry;
  }

  meta(messageId: number): MessageMeta | undefined {
    return this.get(messageId)?.meta;
  }

  /**
   * 该会话在缓存里已知的最大分页序号（群 seq / 私聊 NT seq）。
   *
   * 只读已有观测记录：历史 action 不传锚点时用它，避免要求客户端先自己记 seq。
   */
  latestSequence(isGroup: boolean, targetId: number): number | undefined {
    let best: number | undefined;
    for (const { meta } of this.entries.values()) {
      if (meta.isGroup !== isGroup || meta.targetId !== targetId) continue;
      if (meta.sequenceAuthoritative !== true) continue;
      const sequence = isGroup ? meta.sequence : (meta.ntSequence ?? 0);
      if (!Number.isInteger(sequence) || sequence <= 0) continue;
      if (best === undefined || sequence > best) best = sequence;
    }
    return best;
  }

  forget(messageId: number): void {
    this.entries.delete(messageId);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
