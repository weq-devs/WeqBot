/**
 * 收到的消息与事件的一行式日志（终端 + 落盘）。
 *
 * 参考 SnowLuma 的 `Event` / 消息打印口径，但**不重新建模**：这里只消费
 * `@weqbot/session` 已经定好的语义事件，把 `PeerRef` 和 `elements` 渲染成
 * 人能读的一行。渲染失败一律降级成中性文本 —— 日志永远不该抛。
 *
 * 级别口径：
 *   - 消息、入群、撤回之外的通知 → `info`
 *   - 撤回 / 退群 / 管理变更 / 好友申请 / 群申请 → `warn`（运维要看见）
 */

import type { Logger } from '@weqbot/common';
import type { BotEvent, InboundMessage, NoticeEvent, PeerRef, RequestEvent } from '@weqbot/session';

/** 正文预览上限（字符）；更长的内容截断，避免一行日志吃掉整屏。 */
const MAX_TEXT_PREVIEW = 60;

function truncate(text: string, max = MAX_TEXT_PREVIEW): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/**
 * `[群名(12345)]` / `[昵称(12345)]`；没有缓存到名字时退回 id。
 *
 * 输入状态 / 撤回这类推送只带 uid，名字要等同一会话里出现过消息才会进身份表。
 * 仍没有名字时把 `u_xxx` 缩成短标识，至少比一整串 uid 好认。
 */
function peer(ref: PeerRef | undefined, fallback = '?'): string {
  if (!ref) return fallback;
  const name = ref.name?.trim();
  if (name) return `[${name}(${ref.id})]`;
  if (ref.id.startsWith('u_')) return `[用户 ${ref.id.slice(-6)}]`;
  return ref.id;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

/**
 * 单个消息元素的预览。`elements` 来自 `@weqbot/protocol` 的 decode，
 * 字段名与发送侧一致（`textContent` / `fileName` / `arkData` …）。
 */
function renderElement(element: Record<string, unknown>): string {
  const kind = textOf(element.kind) || 'raw';
  try {
    switch (kind) {
      case 'text':
        return truncate(textOf(element.textContent));
      case 'at': {
        const target = textOf(element.atTargetUid);
        return target ? `@${target.slice(0, 12)}` : '@某人';
      }
      case 'face':
        return textOf(element.faceText) ? `[${textOf(element.faceText)}]` : '[表情]';
      case 'mface':
        return '[商城表情]';
      case 'pic':
        return '[图片]';
      case 'flashPhoto':
        return '[闪照]';
      case 'video':
      case 'bubbleVideo':
        return '[视频]';
      case 'ptt':
        return '[语音]';
      case 'file': {
        const name = textOf(element.fileName);
        return name ? `[文件 ${truncate(name, 30)}]` : '[文件]';
      }
      case 'ark':
        return '[卡片]';
      case 'markdown':
        return '[markdown]';
      case 'multiMsg':
        return '[合并转发]';
      case 'inlineKeyboard':
        return '[按钮消息]';
      case 'wallet':
        return '[红包/钱包]';
      case 'reply':
        return '[回复]';
      case 'pokeEmoji':
      case 'emojiBounce':
        return '[戳一戳]';
      default:
        return `[${kind}]`;
    }
  } catch {
    return '[消息元素]';
  }
}

/** 消息正文预览；空消息给出 `[空消息]`，与 OneBot 侧口径一致。 */
export function formatMessageBody(message: InboundMessage): string {
  const elements = Array.isArray(message.elements) ? message.elements : [];
  const parts = elements.map((element) => renderElement(element)).filter((part) => part !== '');
  return parts.join(' ').trim() || '[空消息]';
}

function sceneLabel(scene: InboundMessage['scene']): string {
  switch (scene) {
    case 'group':
      return '群';
    case 'private':
      return '私聊';
    case 'temp':
      return '临时会话';
    case 'guild':
      return '频道';
    default:
      return String(scene);
  }
}

/** `群 [群名(123)] | [昵称(456)]: #id 正文`。 */
export function formatInboundMessage(message: InboundMessage): string {
  const head = `${sceneLabel(message.scene)} ${peer(message.peer)}`;
  return `${head} | ${peer(message.sender)}: #${message.messageId} ${formatMessageBody(message)}`;
}

export function formatNotice(event: NoticeEvent): string {
  switch (event.kind) {
    case 'group-member-increase':
      return `入群 ${peer(event.group)} | ${peer(event.member)}${
        event.operator ? `（操作者 ${peer(event.operator)}）` : ''
      }`;
    case 'group-member-decrease':
      return `退群 ${peer(event.group)} | ${peer(event.member)}${
        event.operator ? `（操作者 ${peer(event.operator)}）` : ''
      }`;
    case 'group-admin':
      return `管理 ${peer(event.group)} | ${peer(event.member, '')} ${event.detail ?? ''}`.trim();
    case 'group-card':
      return `群名片 ${peer(event.group)} | ${peer(event.member, '')} ${event.detail ?? ''}`.trim();
    case 'group-name':
      return `群名 ${peer(event.group)} ${event.detail ?? ''}`.trim();
    case 'message-recall':
      return `撤回 ${peer(event.peer)} | ${peer(event.sender)} 撤回了 #${event.messageId}`;
    case 'friend-add':
      return `新好友 ${peer(event.friend)}`;
    case 'poke':
      return `戳一戳 ${peer(event.peer)} | ${peer(event.sender)} → ${peer(event.target)}`;
    case 'input-status':
      return `输入中 ${peer(event.peer)} ${truncate(event.text, 20)}`.trim();
    case 'other':
      return `${PUSH_EVENT_LABEL[event.name] ?? '事件'}${event.detail ? ` ${event.detail}` : ''}`;
    default:
      return `事件 ${String((event as { kind?: unknown }).kind ?? 'unknown')}`;
  }
}

/** `kind: 'other'` 的推送名 → 中文标签（detail 由 push 层给可读摘要）。 */
const PUSH_EVENT_LABEL: Record<string, string> = {
  'group-mute': '群禁言',
  'group-reaction': '表情回应',
  'group-essence': '群精华',
  'client-receipt': '消息回执',
};

export function formatRequest(event: RequestEvent): string {
  if (event.kind === 'friend') {
    return `好友申请 ${peer(event.from)}${event.comment ? `: ${truncate(event.comment)}` : ''}`;
  }
  return `${event.invite ? '群邀请' : '群申请'} ${peer(event.group)} | ${peer(event.from)}${
    event.comment ? `: ${truncate(event.comment)}` : ''
  }`;
}

/** 需要以 `warn` 打出来的通知（运维关心的状态变更）。 */
const WARN_KINDS = new Set<NoticeEvent['kind']>([
  'message-recall',
  'group-member-decrease',
  'group-admin',
  'group-card',
  'group-name',
]);

/**
 * 打印一条收到的语义事件。会话级事件（state / online / offline）由
 * `createBot` 自己按状态机打，这里只处理推送侧的三类。
 */
export function logBotEvent(log: Logger, event: BotEvent): void {
  try {
    switch (event.type) {
      case 'message':
        log.info(formatInboundMessage(event.message));
        return;
      case 'notice':
        if (WARN_KINDS.has(event.kind)) log.warn(formatNotice(event));
        else log.info(formatNotice(event));
        return;
      case 'request':
        log.warn(formatRequest(event));
        return;
      default:
        return;
    }
  } catch {
    // 事件渲染失败不能影响推送链路本身。
  }
}
