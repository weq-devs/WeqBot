// 0xFE1_2 — fetch a user's public profile (nickname / sex / age / signature…
// and the QQ level this file used to be limited to).
//
// Schema source: SnowLuma `packages/protocol/src/oidb-services/contacts/
// fetch-user-profile.ts`（2026-11-14），只取 wire schema 与字段常量，
// 运行时用本仓库的 `message()` 重新声明。
//
// `uinForm` 必须为 true：新版本 NTQQ 走 UIN-form 校验，否则报
// `[oidb] one of uid/openid is invaild`。
//
// 属性 key（与 SnowLuma / LagrangeV2 `FetchStrangerService.cs` 交叉核对过）：
//   101   — 头像 proto（AvatarInfo）
//   102   — 个性签名
//   103   — 备注
//   105   — QQ 等级（数值）
//   20002 — 昵称
//   20009 — 性别（1 男 / 2 女 / 其它未知）
//   20037 — 年龄

import { message } from '../../protobuf';
import { toInt } from '../shared';
import { invokeOidb, type OidbSpec } from '../invoke';
import type { OidbNative } from '../../transport';

/** QQ 等级 — OIDB 0xFE1_2 number-property key 105。 */
export const QQ_LEVEL_KEY = 105;

export const PROFILE_KEY = {
  avatar: 101,
  sign: 102,
  remark: 103,
  level: 105,
  nickname: 20002,
  gender: 20009,
  birthday: 20031,
  age: 20037,
  qid: 27394,
} as const;

const USER_INFO_KEY = message([{ name: 'key', tag: 1, type: 'uint32' }]);

const USER_INFO_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'keys', tag: 3, type: USER_INFO_KEY, repeated: true },
]);

const TWO_NUMBER = message([
  { name: 'number1', tag: 1, type: 'uint32' },
  { name: 'number2', tag: 2, type: 'uint32' },
]);

const BYTE_PROPERTY = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'bytes' },
]);

const USER_INFO_PROPERTY = message([
  { name: 'numberProperties', tag: 1, type: TWO_NUMBER, repeated: true },
  { name: 'bytesProperties', tag: 2, type: BYTE_PROPERTY, repeated: true },
]);

const USER_INFO_RESP = message([
  {
    name: 'body',
    tag: 1,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      { name: 'properties', tag: 2, type: USER_INFO_PROPERTY },
      { name: 'uin', tag: 3, type: 'uint32' },
    ]),
  },
]);

/** 请求里不带的值就是「服务端没给」；字段一律给默认值，方便 OneBot 直接透出。 */
export interface UserProfileInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
  qid: string;
  sign: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
  /** QQ 等级；未命中为 0。 */
  level: number;
}

/**
 * 读取 `body.properties` 的两张表。
 *
 * protobuf 里 repeated 字段不存在时是 `undefined`，存在但为空时是 `[]` —— 两种
 * 都当空表处理，别在调用点上到处判空。
 */
export function readProperties(body: Record<string, unknown>): {
  bytes: Map<number, Uint8Array>;
  numbers: Map<number, number>;
} {
  const respBody = body.body as Record<string, unknown> | undefined;
  const props = respBody?.properties as Record<string, unknown> | undefined;
  const bytes = new Map<number, Uint8Array>();
  const numbers = new Map<number, number>();
  for (const entry of (props?.bytesProperties as Record<string, unknown>[] | undefined) ?? []) {
    const value = entry.value;
    if (value instanceof Uint8Array) bytes.set(toInt(entry.code), value);
  }
  for (const entry of (props?.numberProperties as Record<string, unknown>[] | undefined) ?? []) {
    numbers.set(toInt(entry.number1), toInt(entry.number2));
  }
  return { bytes, numbers };
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** 服务端有时省略 uin 回显，所以调用方要传 `requestedUin` 兜底。 */
export function deserializeProfile(
  body: Record<string, unknown>,
  requestedUin: number,
): UserProfileInfo {
  const respBody = body.body as Record<string, unknown> | undefined;
  if (!respBody) throw new Error('user info response body missing');
  const echoed = toInt(respBody.uin);
  if (requestedUin > 0 && echoed > 0 && echoed !== requestedUin) {
    throw new Error(`资料返回的账号不匹配（要求 ${requestedUin}，实际 ${echoed}）`);
  }

  const { bytes, numbers } = readProperties(body);
  const text = (code: number): string => {
    const raw = bytes.get(code);
    return raw ? decoder.decode(raw) : '';
  };
  const gender = numbers.get(PROFILE_KEY.gender) ?? 0;

  return {
    uin: echoed || requestedUin,
    uid: typeof respBody.uid === 'string' ? respBody.uid : '',
    nickname: text(PROFILE_KEY.nickname),
    remark: text(PROFILE_KEY.remark),
    qid: text(PROFILE_KEY.qid),
    sign: text(PROFILE_KEY.sign),
    sex: gender === 1 ? 'male' : gender === 2 ? 'female' : 'unknown',
    age: numbers.get(PROFILE_KEY.age) ?? 0,
    level: numbers.get(PROFILE_KEY.level) ?? 0,
  };
}

export interface QqLevelInfo {
  uin: number;
  /** QQ 等级,未命中/查询失败时为 0。 */
  level: number;
}

/** 只查 QQ 等级的薄封装（保留原调用面）。 */
export namespace GetUserQqLevel {
  export const command = 0xfe1;
  export const subCommand = 2;
  /** Linux 不签，Windows 签（scripts/probe-sign.ts / issue #126）。 */
  export const uinForm = true;
  export const reqSchema = USER_INFO_REQ;
  export const respSchema = USER_INFO_RESP;

  export interface Params {
    uin: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    uin: p.uin,
    keys: [{ key: QQ_LEVEL_KEY }],
  });

  /** The server sometimes elides its uin echo, so callers pass the requested
   *  uin as a fallback; `invoke` binds it via a per-call spec override. */
  export const deserializeWithFallback = (
    body: Record<string, unknown>,
    requestedUin: number,
  ): QqLevelInfo => {
    const respBody = body.body as Record<string, unknown> | undefined;
    if (!respBody) throw new Error('user info response body missing');

    let level = 0;
    const props = respBody.properties as Record<string, unknown> | undefined;
    for (const np of (props?.numberProperties as Record<string, unknown>[] | undefined) ?? []) {
      if (toInt(np.number1) === QQ_LEVEL_KEY) level = toInt(np.number2);
    }
    return { uin: toInt(respBody.uin) || requestedUin, level };
  };

  export const deserialize = (body: Record<string, unknown>): QqLevelInfo =>
    deserializeWithFallback(body, 0);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<QqLevelInfo> =>
    invokeOidb(
      nt,
      pid,
      {
        ...GetUserQqLevel,
        deserialize: (body: Record<string, unknown>) => deserializeWithFallback(body, params.uin),
      } as OidbSpec<Params, QqLevelInfo>,
      params,
    );
}

/** 陌生人 / 群成员资料查询（`get_stranger_info` 用）。 */
export namespace FetchUserProfile {
  export const command = 0xfe1;
  export const subCommand = 2;
  /** 与 `GetUserQqLevel` 同一条命令，同样必须走 UIN-form。 */
  export const uinForm = true;
  export const reqSchema = USER_INFO_REQ;
  export const respSchema = USER_INFO_RESP;

  export interface Params {
    uin: number;
  }

  /** 一次要齐：常见客户端会接着问性别 / 年龄 / 签名，缺了要再打一次。 */
  const REQUESTED_KEYS = [
    PROFILE_KEY.nickname,
    PROFILE_KEY.gender,
    PROFILE_KEY.age,
    PROFILE_KEY.sign,
    PROFILE_KEY.qid,
    PROFILE_KEY.level,
  ];

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.uin) || p.uin <= 0) {
      throw new Error(`uin 必须是正整数，收到 ${String(p.uin)}`);
    }
    return { uin: p.uin, keys: REQUESTED_KEYS.map((key) => ({ key })) };
  };

  export const deserialize = (body: Record<string, unknown>): UserProfileInfo =>
    deserializeProfile(body, 0);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<UserProfileInfo> =>
    invokeOidb(
      nt,
      pid,
      {
        ...FetchUserProfile,
        deserialize: (body: Record<string, unknown>) => deserializeProfile(body, params.uin),
      } as OidbSpec<Params, UserProfileInfo>,
      params,
    );
}
