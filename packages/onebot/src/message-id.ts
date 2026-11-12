/**
 * wire `msg_id` ↔ OneBot `message_id`（int32）的映射。
 *
 * OneBot v11 的 `message_id` 是 int32，而 QQ 的 `msg_id` 是 64 位整数字符串，
 * 直接截断会撞号（尤其群消息），所以：
 *
 *   - 收到消息时给每个 `msg_id` 分配一个**进程内自增**的 int32，并记下反向表；
 *   - 撤回 / 回复等 action 拿 int32 反查回 wire id；
 *   - 表按 peer 分桶 + 有界（LRU），避免长期运行吃内存。
 *
 * 已知取舍：进程重启后旧 `message_id` 失效。OneBot 生态普遍接受这一点
 * （NapCat 等实现同样如此），需要长期引用的场景请用 `message_id` + 自己存。
 */

export interface MessageIdEntry {
  /** wire 上的 `msg_id`（十进制字符串）。 */
  wireId: string;
  peerId: string;
  seq: number;
  at: number;
}

export interface MessageIdMapOptions {
  /** 最多保留多少条，默认 4096。 */
  capacity?: number;
}

export class MessageIdMap {
  private next = 1;
  private readonly capacity: number;
  /** OneBot id → entry。 */
  private readonly byOneBot = new Map<number, MessageIdEntry>();
  /** wire id（含 peer）→ OneBot id，用于「同一条消息被重复推送」时复用。 */
  private readonly byWire = new Map<string, number>();

  constructor(options: MessageIdMapOptions = {}) {
    this.capacity = options.capacity ?? 4096;
  }

  /** 拿（或分配）一条消息的 OneBot id。 */
  intern(entry: MessageIdEntry): number {
    const key = `${entry.peerId}:${entry.wireId}`;
    const existing = this.byWire.get(key);
    if (existing !== undefined) return existing;

    const id = this.next;
    this.next = this.next >= 0x7fffffff ? 1 : this.next + 1;

    this.byOneBot.set(id, entry);
    this.byWire.set(key, id);
    this.evict();
    return id;
  }

  /** 反查：撤回 / 引用时用。 */
  resolve(oneBotId: number): MessageIdEntry | undefined {
    return this.byOneBot.get(oneBotId);
  }

  /** 消息被撤回后可以主动释放。 */
  forget(oneBotId: number): void {
    const entry = this.byOneBot.get(oneBotId);
    if (!entry) return;
    this.byOneBot.delete(oneBotId);
    this.byWire.delete(`${entry.peerId}:${entry.wireId}`);
  }

  private evict(): void {
    while (this.byOneBot.size > this.capacity) {
      const oldest = this.byOneBot.keys().next();
      if (oldest.done) return;
      this.forget(oldest.value);
    }
  }

  get size(): number {
    return this.byOneBot.size;
  }
}
