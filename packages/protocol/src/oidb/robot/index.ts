/**
 * 机器人账号号段：OIDB 0x496_0。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/contacts/fetch-robot-uin-ranges.ts`
 * （2026-11-13），改为 WeqBot 的 `message()` schema 写法。
 *
 * `0xfe7_3` 的群成员回包**没有**机器人标志位。QQ 自己的渲染层就是先拉一次
 * 这份服务端下发的号段，再用「是否落在某个闭区间内」判断非好友成员是不是
 * 机器人。号段会随服务端版本变化，所以必须动态拉取，不能写死。
 *
 * 签名：0x496_0 不在 WeQ 的 SIGN_RULES 里（SnowLuma 也未记录），**三端待实测**。
 */

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

const ROBOT_UIN_RANGE = message([
  { name: 'minUin', tag: 1, type: 'uint64' },
  { name: 'maxUin', tag: 2, type: 'uint64' },
]);

const ROBOT_UIN_RANGE_CONFIG = message([
  { name: 'version', tag: 1, type: 'uint32' },
  { name: 'ranges', tag: 2, type: ROBOT_UIN_RANGE, repeated: true },
]);

const ROBOT_UIN_RANGE_RESP = message([
  { name: 'robotConfig', tag: 5, type: ROBOT_UIN_RANGE_CONFIG },
]);

const ROBOT_UIN_RANGE_REQ = message([
  { name: 'justFetchMsgConfig', tag: 5, type: 'uint32' },
  { name: 'type', tag: 6, type: 'uint32' },
  { name: 'version', tag: 7, type: 'uint32' },
  { name: 'aioKeywordVersion', tag: 8, type: 'uint32' },
]);

export interface RobotUinRange {
  minUin: number;
  maxUin: number;
}

export interface RobotUinRangeSnapshot {
  version: number;
  ranges: RobotUinRange[];
}

function decodeUin(value: unknown, label: string): number {
  const decoded = toInt(value);
  if (decoded <= 0 || decoded > 0xffffffff) {
    throw new Error(`0x496_0 回包的 ${label} 非法: ${String(value)}`);
  }
  return decoded;
}

export namespace FetchRobotUinRanges {
  export const command = 0x496;
  export const subCommand = 0;

  export const reqSchema = ROBOT_UIN_RANGE_REQ;
  export const respSchema = ROBOT_UIN_RANGE_RESP;

  export function serialize(): Record<string, unknown> {
    return { justFetchMsgConfig: 1, type: 1, version: 0, aioKeywordVersion: 0 };
  }

  export function deserialize(body: Record<string, unknown>): RobotUinRangeSnapshot {
    const config = body.robotConfig as Record<string, unknown> | undefined;
    if (!config) throw new Error('0x496_0 回包缺少机器人号段配置');
    if (config.version === undefined) throw new Error('0x496_0 回包缺少版本号');

    const version = toInt(config.version);
    if (version < 0) throw new Error(`0x496_0 回包版本号非法: ${String(config.version)}`);

    const rawRanges = (config.ranges as Record<string, unknown>[] | undefined) ?? [];
    if (rawRanges.length === 0) throw new Error('0x496_0 回包没有机器人号段');

    const ranges = rawRanges.map((range, index) => {
      const minUin = decodeUin(range.minUin, `range[${index}].minUin`);
      const maxUin = decodeUin(range.maxUin, `range[${index}].maxUin`);
      if (minUin > maxUin) {
        throw new Error(`0x496_0 回包号段倒置 range[${index}]: ${minUin}-${maxUin}`);
      }
      return { minUin, maxUin };
    });

    return { version, ranges };
  }

  export function invoke(nt: OidbNative, sessionId: number): Promise<RobotUinRangeSnapshot> {
    return invokeOidb(
      nt,
      sessionId,
      FetchRobotUinRanges as unknown as OidbSpec<Record<string, never>, RobotUinRangeSnapshot>,
      {},
    );
  }
}

/** 判断一个 QQ 号是否落在机器人号段内。 */
export function isRobotUin(snapshot: RobotUinRangeSnapshot, uin: number): boolean {
  return snapshot.ranges.some((range) => uin >= range.minUin && uin <= range.maxUin);
}
