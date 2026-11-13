/**
 * 群名片解码。
 *
 * 搬运自 SnowLuma `packages/protocol/src/group-member-card.ts`（2026-11-13）。
 *
 * 群名片在 wire 上有两种形态，且**共享同一个字段**（tag 11 / `memberCard`）：
 *   - 纯 UTF-8 文本；
 *   - 结构化 `RichGroupCard { parts[{ text, control }] }`（tag 0x0a 开头）。
 *
 * 判别方法是「能不能按结构化解出 parts」：能就用结构化文本，不能就按纯文本。
 * 纯文本里可能含换行（0x0a），所以不能只看首字节。任一部分带 `control`
 * 时整段按控件处理，不输出文本。
 */

import { decode, message } from '../../protobuf';

const GROUP_CARD_PART = message([
  { name: 'text', tag: 1, type: 'string' },
  { name: 'control', tag: 2, type: 'bytes' },
]);

const GROUP_CARD = message([{ name: 'parts', tag: 1, type: GROUP_CARD_PART, repeated: true }]);

/**
 * 是不是「二进制垃圾」文本。
 *
 * 判据：含 C0 控制符（**保留 tab / LF / CR**）或 DEL。名片里出现这些字符
 * 说明服务端给的是结构化二进制，不是可展示的名字。
 *
 * 用字符码判断而不是正则：正则里的控制字符既不好读，也会触发 lint 告警。
 */
export function isBinaryCardText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** 去掉同一批控制字符（保留 tab / LF / CR）。 */
function stripBinaryControls(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const control =
      code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);
    if (!control) out += text[index];
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function utf8Text(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw new Error('群名片不是合法 UTF-8', { cause });
  }
}

function displayText(bytes: Uint8Array): string {
  const text = utf8Text(bytes);
  if (isBinaryCardText(text)) throw new Error('群名片含二进制控制字符');
  return text;
}

/** 解群名片；解析失败返回空串（名片是可选的展示字段，不该影响消息本身）。 */
export function decodeGroupMemberCard(bytes?: Uint8Array): string {
  if (!bytes?.length) return '';

  // 不含 0x0a 一定不是结构化名片。
  if (!bytes.includes(0x0a)) return displayText(bytes);

  let parts: { text?: string; control?: Uint8Array }[] | undefined;
  try {
    parts = (decode(GROUP_CARD, bytes) as { parts?: { text?: string; control?: Uint8Array }[] })
      .parts;
  } catch {
    // 纯文本名片里的换行也是 0x0a；整段是合法展示文本就接受。
    return displayText(bytes);
  }
  if (!parts?.length) return displayText(bytes);

  // 带 control 的部分优先级高于同段文本：只收集无 control 的文本段。
  const text = parts
    .filter((part) => part.control == null && part.text != null)
    .map((part) => part.text!)
    .join('');
  return stripBinaryControls(text);
}
