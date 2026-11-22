import { pbGetBytes, pbGetVarint } from '../call/gcs';
import { decodePushEnvelope } from '../push/decode';

export interface GroupCallChatPush {
  groupId: number;
  room: number;
  senderUin: number;
  recipientUin: number;
  messageId: number;
  text: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 0x210/0x126 的通话面板消息。正文是带内联表情标记的 UTF-8。 */
export function decodeGroupCallChatPushes(body: Uint8Array): GroupCallChatPush[] {
  return decodePushEnvelope(body).messages.flatMap((message) => {
    if (message.contentHead?.msgType !== 528 || message.contentHead.subType !== 294) return [];
    const content = message.body?.msgContent;
    const event = content && pbGetBytes(content, 3);
    const roomInfo = event && pbGetBytes(event, 1);
    const chat = event && pbGetBytes(event, 2);
    if (!roomInfo || !chat) return [];

    const groupId = pbGetVarint(roomInfo, 2);
    const room = pbGetVarint(roomInfo, 3);
    const senderUin = pbGetVarint(chat, 1);
    const recipientUin = message.responseHead?.toUin;
    const messageId = pbGetVarint(chat, 4);
    const textBytes = pbGetBytes(chat, 2);
    if (
      !groupId ||
      !room ||
      !senderUin ||
      !recipientUin ||
      messageId === undefined ||
      !textBytes?.length
    ) {
      return [];
    }
    if (senderUin !== message.responseHead?.fromUin) return [];
    try {
      return [{ groupId, room, senderUin, recipientUin, messageId, text: utf8.decode(textBytes) }];
    } catch {
      return [];
    }
  });
}
