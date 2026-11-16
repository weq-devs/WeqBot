/**
 * uid ↔ uin 的**观测缓存**。
 *
 * QQ 的推送里两种 id 混着出现：聊天消息带 uid（`u_...`）也有 uin，输入状态、
 * 撤回、入群申请这类系统推送**只有 uid**，而 OneBot 的 `@` / 撤回 / 群管理
 * 动作全部以 uin 为参数。所以必须有一层双向映射。
 *
 * 三条纪律：
 *
 *   1. **只从观测里建**：聊天消息的 `sender` / `session`、群成员列表、好友列表
 *      都是权威来源；不做 uid → uin 的算法推导（协议没这个能力）。
 *   2. **不落盘**：这是会话期缓存，重启后第一条消息就会重建；落盘反而会把
 *      别人的映射长期留在本机。
 *   3. **有界**：长跑 bot 会见到几十万条消息，用插入序淘汰最老的，避免无界增长。
 *
 * 缓存没有「权威来源」的概念：同一个 uid 先后观测到不同 uin 时以**最新**为准
 * （账号迁移 / 观测错位时，最近的消息更可信）。
 */
export class IdentityCache {
  private readonly uinByUid = new Map<string, string>();
  private readonly uidByUin = new Map<string, string>();
  /** uin / uid → 显示名。来源是消息里的昵称、群名片、好友列表与群列表。 */
  private readonly nameByUin = new Map<string, string>();
  private readonly nameByUid = new Map<string, string>();

  constructor(private readonly capacity = 8192) {}

  /** 记录一条观测；uid / uin 任一不合法就忽略。 */
  observe(
    uid: string | null | undefined,
    uin: number | string | null | undefined,
    name?: string | null,
  ): void {
    if (!uid?.startsWith('u_')) return;
    const value =
      typeof uin === 'string' ? uin.trim() : uin === null || uin === undefined ? '' : String(uin);
    if (!/^\d{4,}$/.test(value)) return;

    // 同一个 uid 换了 uin：先把旧的反向映射删掉，不能留一条指向自己的驴头。
    const oldUin = this.uinByUid.get(uid);
    if (oldUin && oldUin !== value && this.uidByUin.get(oldUin) === uid) {
      this.uidByUin.delete(oldUin);
    }

    this.uinByUid.delete(uid);
    this.uinByUid.set(uid, value);

    const previous = this.uidByUin.get(value);
    if (previous && previous !== uid) this.uinByUid.delete(previous);
    this.uidByUin.set(value, uid);

    if (name?.trim()) this.observeName({ uid, uin: value }, name);
    this.evict();
  }

  /**
   * 记录显示名。`uin` 是群号 / QQ 号，`uid` 是 `u_...`，两者可以只给一个。
   *
   * 昵称不是权威映射，只用于日志渲染；空串与纯空白忽略，避免把名字覆盖掉。
   */
  observeName(
    input: { uid?: string | null; uin?: number | string | null },
    name: string | null | undefined,
  ): void {
    const display = name?.trim();
    if (!display) return;
    const uin =
      typeof input.uin === 'string'
        ? input.uin.trim()
        : input.uin === null || input.uin === undefined
          ? ''
          : String(input.uin);
    const uid = input.uid?.startsWith('u_') ? input.uid : undefined;
    if (/^\d{4,}$/.test(uin)) this.nameByUin.set(uin, display);
    if (uid) this.nameByUid.set(uid, display);
    this.evict();
  }

  /** uin → 显示名。 */
  nameOfUin(uin: string | number | null | undefined): string | undefined {
    const key = uin === null || uin === undefined ? '' : String(uin);
    return key ? this.nameByUin.get(key) : undefined;
  }

  /** uid → 显示名。 */
  nameOfUid(uid: string | null | undefined): string | undefined {
    return uid ? this.nameByUid.get(uid) : undefined;
  }

  /** 从 `PeerRef` 形状里取显示名：uid 优先，退回 id（群号 / uin）。 */
  nameOf(ref: { id?: string; uid?: string } | undefined): string | undefined {
    if (!ref) return undefined;
    return this.nameOfUid(ref.uid) ?? this.nameOfUin(ref.id);
  }

  /** uid → uin。未观测到返回 `undefined`。 */
  uinOf(uid: string | null | undefined): string | undefined {
    return uid ? this.uinByUid.get(uid) : undefined;
  }

  /** uin → uid。未观测到返回 `undefined`。 */
  uidOf(uin: string | number | null | undefined): string | undefined {
    const key = uin === null || uin === undefined ? '' : String(uin);
    return key ? this.uidByUin.get(key) : undefined;
  }

  get size(): number {
    return this.uinByUid.size;
  }

  clear(): void {
    this.uinByUid.clear();
    this.uidByUin.clear();
    this.nameByUin.clear();
    this.nameByUid.clear();
  }

  private evict(): void {
    while (this.uinByUid.size > this.capacity) {
      const oldest = this.uinByUid.keys().next();
      if (oldest.done) return;
      const uin = this.uinByUid.get(oldest.value);
      this.uinByUid.delete(oldest.value);
      if (uin && this.uidByUin.get(uin) === oldest.value) this.uidByUin.delete(uin);
    }
    while (this.uidByUin.size > this.capacity) {
      const oldest = this.uidByUin.keys().next();
      if (oldest.done) return;
      const uid = this.uidByUin.get(oldest.value);
      this.uidByUin.delete(oldest.value);
      if (uid && this.uinByUid.get(uid) === oldest.value) this.uinByUid.delete(uid);
    }
    while (this.nameByUin.size > this.capacity) {
      const oldest = this.nameByUin.keys().next();
      if (oldest.done) break;
      this.nameByUin.delete(oldest.value);
    }
    while (this.nameByUid.size > this.capacity) {
      const oldest = this.nameByUid.keys().next();
      if (oldest.done) return;
      this.nameByUid.delete(oldest.value);
    }
  }
}
