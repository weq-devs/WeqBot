/**
 * 服务端推送解码。
 *
 * **分界线**：native 只解密、剥 SSO 头，把 `(command, body)` 原样交出来（见
 * `PushFrame`）；这里按 command 找 decoder，解码成业务对象。
 *
 * 这样新增一种推送（新 trpc 服务、新 oidb 推送）只改 TS，不用重发 native 二进制。
 *
 * TODO(P3) 搬运/实现：
 *   - `trpc.msg.olpush.OlPushService.MsgPush` → 消息 / 撤回 / 已读 / 群通知
 *   - `trpc.qq_new_tech.status_svc.StatusService.KickNT` → 被踢
 *   - `RegisterProxy.InfoSyncPush` → 关注列表同步（好友/群变动）
 *   - `trpc.msg.register_proxy.RegisterProxy.SsoInfoSync` 的回执（注册结果）
 */

import type { PushFrame } from '@weqbot/wire';

export interface DecodedPush {
  /** 归一后的推送名，直接用于事件路由。 */
  kind: string;
  /** decoder 自己的负载；`session` 负责翻译成 `BotEvent`。 */
  payload: unknown;
}

export interface PushDecoder {
  /** 精确匹配的 SSO 命令字符串。 */
  command: string;
  decode(frame: PushFrame): DecodedPush | undefined;
}

/** 注册表：P3 落地时往里加 decoder。 */
export const PUSH_DECODERS: readonly PushDecoder[] = [];

export function findPushDecoder(command: string): PushDecoder | undefined {
  return PUSH_DECODERS.find((decoder) => decoder.command === command);
}

/**
 * 解码一帧推送。
 *
 * 未注册的 command 返回 `undefined` 而不是抛错：QQ 会推很多我们暂不关心的服务，
 * 每一条都抛异常会淹没有用信息。调用方按需 `debug` 记录 command 名。
 */
export function decodePush(frame: PushFrame): DecodedPush | undefined {
  return findPushDecoder(frame.command)?.decode(frame);
}

export type { PushFrame };
