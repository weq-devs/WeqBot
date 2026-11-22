import { decodePushEnvelope } from '../push/decode';
import { groupFields } from './signaling';

/** 0x210/0x116 的待响应名单变化。拒绝和超时共用此结构。 */
export function decodeGroupCallInviteUpdates(body: Uint8Array): Array<{
  groupId: number;
  room: number;
  started: boolean;
  uids: string[];
}> {
  return decodePushEnvelope(body).messages.flatMap((message) => {
    if (message.contentHead?.msgType !== 528 || message.contentHead.subType !== 278) return [];
    const content = message.body?.msgContent;
    if (!content) return [];
    const fields = groupFields(content);
    const groupId = fields.get(3)?.[0];
    const room = fields.get(4)?.[0];
    if (typeof groupId !== 'number' || typeof room !== 'number') return [];
    const type = fields.get(6)?.[0];
    if (type !== 1 && type !== 3) return [];
    const started = type === 1;
    const uids = (fields.get(started ? 1 : 2) ?? []).flatMap((entry) => {
      if (typeof entry === 'number') return [];
      const uid = groupFields(entry).get(1)?.[0];
      const value = uid instanceof Uint8Array ? new TextDecoder().decode(uid) : '';
      return /^u_[\w-]+$/.test(value) ? [value] : [];
    });
    return uids.length ? [{ groupId, room, started, uids }] : [];
  });
}
