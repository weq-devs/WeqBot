/**
 * OneBot `set_group_add_request` 的 flag 解析。
 *
 * flag 是**不透明句柄**：客户端不构造它，只把事件里的原样回传。但 WeqBot 自己
 * 会产出三种形态，`0x10C8_1/2` 又只认 `(groupId, sequence, eventType, filtered)`
 * 四元组，所以处理前必须先解码：
 *
 *   - `slreq:1:<sequence>:<groupId>:<eventType>:<filtered>` —— `get_group_system_msg`
 *     自己生成的规范形态，四元组齐全，无需再查收件箱（只在要 `operateTransInfo`
 *     时回查一次）；
 *   - `<sequence>` —— 裸序号。任何协议版本都可能给，必须去收件箱反查群号与类型；
 *   - `add:<groupId>:<uid>` / `invite:<groupId>:<uid>` —— 实时推送
 *     （`push/registry.ts` 的 84 / 525 / 87）产出的旧形态，只有群号 + 申请人 uid，
 *     类型也是猜的，必须去收件箱反查。
 *
 * 解析只做语法，不碰网络；反查在 `onebot-backend.ts` 里。
 */

export type ParsedGroupRequestFlag =
  /** 四元组齐全，拿来就能发。 */
  | { kind: 'canonical'; sequence: number; groupId: number; eventType: number; filtered: boolean }
  /** 只有序号。 */
  | { kind: 'sequence'; sequence: number }
  /** 旧推送形态：群号 + 申请人 uid。 */
  | { kind: 'legacy'; requestType: 'add' | 'invite'; groupId: number; targetUid: string };

function positiveSafeInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`群请求 flag 的 ${field} 非法：${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`群请求 flag 的 ${field} 非法：${value}`);
  }
  return parsed;
}

/**
 * 解码 flag。
 *
 * 非法形态直接抛 —— 宁可报错也不要拿着猜出来的四元组去发审批请求，那可能
 * 同意/拒绝到一条别的申请上。
 */
export function parseGroupRequestFlag(flag: string): ParsedGroupRequestFlag {
  const raw = flag.trim();
  if (!raw) throw new Error('群请求 flag 不能为空');

  // 裸序号（OneBot 实现里常见）。
  if (/^\d+$/.test(raw))
    return { kind: 'sequence', sequence: positiveSafeInteger(raw, 'sequence') };

  const parts = raw.split(':');

  if (parts[0] === 'slreq') {
    if (parts.length !== 6 || parts[1] !== '1') {
      throw new Error(`不支持的群请求 flag：${raw}`);
    }
    if (parts[5] !== '0' && parts[5] !== '1') {
      throw new Error(`群请求 flag 的 filtered 标记非法：${raw}`);
    }
    return {
      kind: 'canonical',
      sequence: positiveSafeInteger(parts[2]!, 'sequence'),
      groupId: positiveSafeInteger(parts[3]!, 'group_id'),
      eventType: positiveSafeInteger(parts[4]!, 'event_type'),
      filtered: parts[5] === '1',
    };
  }

  const requestType = parts[0];
  if ((requestType !== 'add' && requestType !== 'invite') || parts.length < 3) {
    throw new Error(`不支持的群请求 flag：${raw}`);
  }

  const groupId = positiveSafeInteger(parts[1]!, 'group_id');
  // uid 里理论上不含 `:`，但用 slice 拼回去更稳（不丢信息）。
  const targetUid = parts.slice(2).join(':').trim();
  if (!targetUid) throw new Error('群请求 flag 里没有申请人 uid');

  return { kind: 'legacy', requestType, groupId, targetUid };
}
