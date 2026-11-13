/**
 * 用户资料属性解码（好友列表 / 资料卡共用）。
 *
 * 搬运自 SnowLuma `packages/protocol/src/oidb-services/contacts/public-profile.ts`
 * （2026-11-13），改为 WeqBot 的 protobuf 运行时写法。语义保持：
 * 属性表是 `code → bytes`（文本 / 二进制）与 `code → number`（数值），
 * 服务端按请求的 key 列表逐项返回，缺项就是不支持，不是错误。
 *
 * 未知 wire 字段会抛错：雪崩式静默解出错误资料比直接报错更难排查。
 */

import { decode, message } from '../../protobuf';
import { toInt } from '../shared';

/** 好友列表与资料查询共用的属性 key 列表。 */
export const PUBLIC_PROFILE_KEYS = [
  102, 105, 107, 20003, 20004, 20020, 20009, 20011, 20016, 20021, 20031, 20037, 41756, 41757, 42241,
] as const;

/** 权限图标（tag 107 里的嵌套 protobuf）。 */
const PROFILE_PRIVILEGE = message([
  { name: 'type', tag: 1, type: 'int32' },
  { name: 'level', tag: 4, type: 'int32' },
  { name: 'flag', tag: 5, type: 'int32' },
  { name: 'iconUrl', tag: 6, type: 'bytes' },
  { name: 'deluxeIconUrl', tag: 7, type: 'bytes' },
  { name: 'jumpUrl', tag: 8, type: 'bytes' },
  { name: 'isBig', tag: 9, type: 'int32' },
]);

const PROFILE_PRIVILEGE_LISTS = message([
  { name: 'jumpUrl', tag: 2, type: 'bytes' },
  { name: 'open', tag: 3, type: PROFILE_PRIVILEGE, repeated: true },
  { name: 'closed', tag: 4, type: PROFILE_PRIVILEGE, repeated: true },
]);

const PROFILE_PRIVILEGES = message([{ name: 'lists', tag: 3, type: PROFILE_PRIVILEGE_LISTS }]);

export interface ProfilePrivilege {
  type?: number;
  level?: number;
  flag?: number;
  isBig?: boolean;
  iconUrl?: string;
  deluxeIconUrl?: string;
  jumpUrl?: string;
}

export interface PublicProfileFields {
  sign?: string;
  email?: string;
  phoneNum?: string;
  country?: string;
  province?: string;
  city?: string;
  college?: string;
  age?: number;
  level?: number;
  sex?: 'male' | 'female' | 'unknown';
  birthdayYear?: number;
  birthdayMonth?: number;
  birthdayDay?: number;
  vipFlag?: boolean;
  yearVipFlag?: boolean;
  svipFlag?: boolean;
  vipLevel?: number;
  privilegeIcons?: {
    jumpUrl?: string;
    open: ProfilePrivilege[];
    closed: ProfilePrivilege[];
  };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function text(value: Uint8Array, code: number): string {
  try {
    return decoder.decode(value);
  } catch (cause) {
    throw new Error(`profile property ${code} 不是合法 UTF-8`, { cause });
  }
}

/** 1990 年前的生日按「未填」处理（QQ 常写 0）。 */
export function decodeBirthday(
  raw: Uint8Array,
): Pick<PublicProfileFields, 'birthdayYear' | 'birthdayMonth' | 'birthdayDay'> {
  if (raw.length !== 4) throw new Error('生日字段（20031）长度不是 4');
  const year = (raw[0]! << 8) | raw[1]!;
  const month = raw[2]!;
  const day = raw[3]!;
  if (month === 0 && day === 0) return {};

  const date = new Date(0);
  date.setUTCFullYear(year || 2000, month - 1, day);
  if (year > 9999 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('生日字段（20031）不是合法日期');
  }
  return {
    ...(year > 0 ? { birthdayYear: year } : {}),
    birthdayMonth: month,
    birthdayDay: day,
  };
}

/** 会员标志位（41756）与等级（41757）：QQ 用 bit 位混装多个 VIP 类型。 */
export function decodeMembership(
  numbers: ReadonlyMap<number, number>,
): Pick<PublicProfileFields, 'vipFlag' | 'yearVipFlag' | 'svipFlag' | 'vipLevel'> {
  const result: Pick<PublicProfileFields, 'vipFlag' | 'yearVipFlag' | 'svipFlag' | 'vipLevel'> = {};
  const flags = numbers.get(41756);
  if (flags !== undefined) {
    result.vipFlag = (flags & 1) !== 0;
    result.yearVipFlag = (flags & 2) !== 0;
    result.svipFlag = (flags & 0x100) !== 0;
  }

  const level = numbers.get(41757);
  if (level !== undefined) {
    const mask = level & 0xfff;
    if (mask !== 0) {
      result.vipLevel = 33 - Math.clz32(mask);
    } else if (
      result.vipFlag ||
      result.yearVipFlag ||
      result.svipFlag ||
      numbers.get(42241) === 1
    ) {
      result.vipLevel = 1;
    } else if (flags !== undefined && numbers.has(42241)) {
      result.vipLevel = 0;
    }
  }
  return result;
}

function privilege(entry: Record<string, unknown>): ProfilePrivilege {
  const out: ProfilePrivilege = {};
  if (entry.type !== undefined) out.type = toInt(entry.type);
  if (entry.level !== undefined) out.level = toInt(entry.level);
  if (entry.flag !== undefined) out.flag = toInt(entry.flag);
  if (entry.isBig !== undefined) out.isBig = toInt(entry.isBig) === 1;
  if (entry.iconUrl instanceof Uint8Array) out.iconUrl = text(entry.iconUrl, 107);
  if (entry.deluxeIconUrl instanceof Uint8Array) out.deluxeIconUrl = text(entry.deluxeIconUrl, 107);
  if (entry.jumpUrl instanceof Uint8Array) out.jumpUrl = text(entry.jumpUrl, 107);
  return out;
}

/**
 * 把属性表解码成稳定形状。
 *
 * `bytes` 是 `code → 原始值`，`numbers` 是 `code → 数值`；两者由调用方
 * 从好友条目 / 资料回包里抽出来（不同命令的外层结构不同）。
 */
export function decodePublicProfile(
  bytes: ReadonlyMap<number, Uint8Array>,
  numbers: ReadonlyMap<number, number>,
): PublicProfileFields {
  const result: PublicProfileFields = {};

  for (const [code, field] of [
    [102, 'sign'],
    [20011, 'email'],
    [20016, 'phoneNum'],
    [20003, 'country'],
    [20004, 'province'],
    [20020, 'city'],
    [20021, 'college'],
  ] as const) {
    const value = bytes.get(code);
    if (value !== undefined) result[field] = text(value, code);
  }

  for (const [code, field] of [
    [20037, 'age'],
    [105, 'level'],
  ] as const) {
    const value = numbers.get(code);
    if (value !== undefined && Number.isInteger(value) && value >= 0) result[field] = value;
  }

  const sex = numbers.get(20009);
  if (sex !== undefined) result.sex = sex === 1 ? 'male' : sex === 2 ? 'female' : 'unknown';

  const birthday = bytes.get(20031);
  if (birthday !== undefined && birthday.length > 0) {
    try {
      Object.assign(result, decodeBirthday(birthday));
    } catch {
      // 生日格式异常不影响其它字段；上游也只是告警。
    }
  }

  Object.assign(result, decodeMembership(numbers));

  const icons = bytes.get(107);
  if (icons !== undefined) {
    const decoded = decode(PROFILE_PRIVILEGES, icons) as {
      lists?: {
        jumpUrl?: Uint8Array;
        open?: Record<string, unknown>[];
        closed?: Record<string, unknown>[];
      };
    };
    // 没有 lists 表示「不可用」，不是「空列表」。
    if (decoded.lists) {
      result.privilegeIcons = {
        ...(decoded.lists.jumpUrl instanceof Uint8Array
          ? { jumpUrl: text(decoded.lists.jumpUrl, 107) }
          : {}),
        open: (decoded.lists.open ?? []).map(privilege),
        closed: (decoded.lists.closed ?? []).map(privilege),
      };
    }
  }

  return result;
}
