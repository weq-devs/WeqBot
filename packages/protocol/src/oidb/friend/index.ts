/**
 * 删除好友（0x126b_0）。
 * 请求字段来自 SnowLuma `packages/protocol/src/oidb-services/friend/*`。
 */

import { message } from '../../protobuf';
import type { OidbNative } from '../../transport';
import { invokeOidb, type OidbSpec } from '../invoke';

export {
  GetUnidirectionalFriendList,
  type GetUnidirectionalFriendListParams,
  type UnidirectionalFriendEntry,
} from './unidirectional';

// ───────────────────────── 删好友 — 0x126b_0 ─────────────────────────

const DELETE_FRIEND_LEVEL2 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
]);

const DELETE_FRIEND_LEVEL1 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: DELETE_FRIEND_LEVEL2 },
]);

const DELETE_FRIEND_TARGET = message([
  { name: 'targetUid', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: DELETE_FRIEND_LEVEL1 },
  { name: 'block', tag: 3, type: 'bool' },
  { name: 'field4', tag: 4, type: 'bool' },
]);

const DELETE_FRIEND_REQ = message([{ name: 'field1', tag: 1, type: DELETE_FRIEND_TARGET }]);

/**
 * 服务端判别用的魔数。它们不是 SnowLuma 的发明 —— 与 QQ 客户端发出的字节
 * 一致，任何一位错都会被拒。**不要**试着「简化」这层嵌套。
 */
const DELETE_FRIEND_MAGIC = {
  field1: 130,
  field2: 109,
  inner: { field1: 8, field2: 8, field3: 50 },
} as const;

export interface DeleteFriendParams {
  /** 对方 uid（`u_...`），不是 QQ 号。 */
  targetUid: string;
  /** 同时拉黑。默认 false。 */
  block?: boolean;
}

export namespace DeleteFriend {
  export const command = 0x126b;
  export const subCommand = 0;
  export const uinForm = false;

  export const reqSchema = DELETE_FRIEND_REQ;
  export const respSchema = message([]);

  export function serialize(params: DeleteFriendParams): Record<string, unknown> {
    if (!params.targetUid.trim()) throw new Error('删好友需要对方 uid');
    return {
      field1: {
        targetUid: params.targetUid,
        field2: {
          field1: DELETE_FRIEND_MAGIC.field1,
          field2: DELETE_FRIEND_MAGIC.field2,
          field3: DELETE_FRIEND_MAGIC.inner,
        },
        block: params.block ?? false,
        field4: true,
      },
    };
  }

  export function deserialize(): void {}

  export function invoke(
    nt: OidbNative,
    sessionId: number,
    params: DeleteFriendParams,
  ): Promise<void> {
    return invokeOidb(nt, sessionId, DeleteFriend as OidbSpec<DeleteFriendParams, void>, params);
  }
}
