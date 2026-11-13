/**
 * OIDB 0xfe5_2 —— 已加入的群列表（含群资料与机器人侧备注）。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/contacts/fetch-group-list.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * `config` 是个布尔开关表，告诉服务端「要点哪些字段」。全开时群很多的账号会
 * 撞上命名管道写缓冲上限，所以保留 SnowLuma 的取舍：
 * `field5002` / `field5003` 关掉，`config2` 只开 `remark`。
 *
 * 签名：0xfe5_2 在 WeQ 的 SIGN_RULES 里是 `non-linux`（Linux 不签），
 * **三端待复核**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

const GROUP_OWNER = message([{ name: 'uid', tag: 2, type: 'string' }]);

const GROUP_INFO = message([
  { name: 'groupOwner', tag: 1, type: GROUP_OWNER },
  { name: 'createdTime', tag: 2, type: 'uint32' },
  { name: 'memberMax', tag: 3, type: 'uint32' },
  { name: 'memberCount', tag: 4, type: 'uint32' },
  { name: 'groupName', tag: 5, type: 'string' },
  { name: 'shutUpAllTimestamp', tag: 10, type: 'uint32' },
  { name: 'description', tag: 18, type: 'string' },
  { name: 'question', tag: 19, type: 'string' },
  { name: 'announcement', tag: 30, type: 'string' },
]);

const GROUP_CUSTOM_INFO = message([{ name: 'remark', tag: 3, type: 'string' }]);

const GROUP = message([
  { name: 'groupUin', tag: 3, type: 'uint32' },
  { name: 'info', tag: 4, type: GROUP_INFO },
  { name: 'customInfo', tag: 5, type: GROUP_CUSTOM_INFO },
]);

const GROUP_LIST_RESP = message([{ name: 'groups', tag: 2, type: GROUP, repeated: true }]);

const GROUP_LIST_CONFIG1 = message([
  { name: 'groupOwner', tag: 1, type: 'bool' },
  { name: 'field2', tag: 2, type: 'bool' },
  { name: 'memberMax', tag: 3, type: 'bool' },
  { name: 'memberCount', tag: 4, type: 'bool' },
  { name: 'groupName', tag: 5, type: 'bool' },
  { name: 'field8', tag: 8, type: 'bool' },
  { name: 'field9', tag: 9, type: 'bool' },
  { name: 'field10', tag: 10, type: 'bool' },
  { name: 'field11', tag: 11, type: 'bool' },
  { name: 'field12', tag: 12, type: 'bool' },
  { name: 'field13', tag: 13, type: 'bool' },
  { name: 'field14', tag: 14, type: 'bool' },
  { name: 'field15', tag: 15, type: 'bool' },
  { name: 'field16', tag: 16, type: 'bool' },
  { name: 'field17', tag: 17, type: 'bool' },
  { name: 'field18', tag: 18, type: 'bool' },
  { name: 'question', tag: 19, type: 'bool' },
  { name: 'field20', tag: 20, type: 'bool' },
  { name: 'field22', tag: 22, type: 'bool' },
  { name: 'field23', tag: 23, type: 'bool' },
  { name: 'field24', tag: 24, type: 'bool' },
  { name: 'field25', tag: 25, type: 'bool' },
  { name: 'field26', tag: 26, type: 'bool' },
  { name: 'field27', tag: 27, type: 'bool' },
  { name: 'field28', tag: 28, type: 'bool' },
  { name: 'field29', tag: 29, type: 'bool' },
  { name: 'field30', tag: 30, type: 'bool' },
  { name: 'field31', tag: 31, type: 'bool' },
  { name: 'field32', tag: 32, type: 'bool' },
  { name: 'field5001', tag: 5001, type: 'bool' },
  { name: 'field5002', tag: 5002, type: 'bool' },
  { name: 'field5003', tag: 5003, type: 'bool' },
]);

const GROUP_LIST_CONFIG2 = message([
  { name: 'field1', tag: 1, type: 'bool' },
  { name: 'field2', tag: 2, type: 'bool' },
  { name: 'remark', tag: 3, type: 'bool' },
  { name: 'field4', tag: 4, type: 'bool' },
  { name: 'field5', tag: 5, type: 'bool' },
  { name: 'field6', tag: 6, type: 'bool' },
  { name: 'field7', tag: 7, type: 'bool' },
  { name: 'field8', tag: 8, type: 'bool' },
]);

const GROUP_LIST_CONFIG3 = message([
  { name: 'field5', tag: 5, type: 'bool' },
  { name: 'field6', tag: 6, type: 'bool' },
]);

const GROUP_LIST_CONFIG = message([
  { name: 'config1', tag: 1, type: GROUP_LIST_CONFIG1 },
  { name: 'config2', tag: 2, type: GROUP_LIST_CONFIG2 },
  { name: 'config3', tag: 3, type: GROUP_LIST_CONFIG3 },
]);

const GROUP_LIST_REQ = message([{ name: 'config', tag: 1, type: GROUP_LIST_CONFIG }]);

export interface GroupInfo {
  groupId: number;
  groupName: string;
  memberCount: number;
  memberMax: number;
  ownerUid: string;
  createdAt: number;
  description: string;
  question: string;
  announcement: string;
  /** 全员禁言到期时间：0 = 未禁言，0xffffffff = 永久，其余为 unix 秒。 */
  shutUpAllTimestamp: number;
  /** 机器人侧给群设置的备注。 */
  remark: string;
}

export namespace FetchGroupList {
  export const command = 0xfe5;
  export const subCommand = 2;

  export const reqSchema = GROUP_LIST_REQ;
  export const respSchema = GROUP_LIST_RESP;

  const allTrue = true;

  export function serialize(): Record<string, unknown> {
    return {
      config: {
        config1: {
          groupOwner: allTrue,
          field2: allTrue,
          memberMax: allTrue,
          memberCount: allTrue,
          groupName: allTrue,
          field8: allTrue,
          field9: allTrue,
          field10: allTrue,
          field11: allTrue,
          field12: allTrue,
          field13: allTrue,
          field14: allTrue,
          field15: allTrue,
          field16: allTrue,
          field17: allTrue,
          field18: allTrue,
          question: allTrue,
          field20: allTrue,
          field22: allTrue,
          field23: allTrue,
          field24: allTrue,
          field25: allTrue,
          field26: allTrue,
          field27: allTrue,
          field28: allTrue,
          field29: allTrue,
          field30: allTrue,
          field31: allTrue,
          field32: allTrue,
          field5001: allTrue,
          // 全开会撞写缓冲上限，详见文件头。
          field5002: false,
          field5003: false,
        },
        config2: {
          field1: false,
          field2: false,
          remark: true,
          field4: false,
          field5: false,
          field6: false,
          field7: false,
          field8: false,
        },
        config3: { field5: allTrue, field6: allTrue },
      },
    };
  }

  export function deserialize(body: Record<string, unknown>): GroupInfo[] {
    return ((body.groups as Record<string, unknown>[] | undefined) ?? []).map((raw) => {
      const info = (raw.info as Record<string, unknown> | undefined) ?? {};
      const owner = (info.groupOwner as Record<string, unknown> | undefined) ?? {};
      const custom = (raw.customInfo as Record<string, unknown> | undefined) ?? {};
      return {
        groupId: toInt(raw.groupUin),
        groupName: typeof info.groupName === 'string' ? info.groupName : '',
        memberCount: toInt(info.memberCount),
        memberMax: toInt(info.memberMax),
        ownerUid: typeof owner.uid === 'string' ? owner.uid : '',
        createdAt: toInt(info.createdTime),
        description: typeof info.description === 'string' ? info.description : '',
        question: typeof info.question === 'string' ? info.question : '',
        announcement: typeof info.announcement === 'string' ? info.announcement : '',
        shutUpAllTimestamp: toInt(info.shutUpAllTimestamp),
        remark: typeof custom.remark === 'string' ? custom.remark : '',
      };
    });
  }

  export function invoke(nt: OidbNative, sessionId: number): Promise<GroupInfo[]> {
    return invokeOidb(
      nt,
      sessionId,
      FetchGroupList as unknown as OidbSpec<Record<string, never>, GroupInfo[]>,
      {},
    );
  }
}
