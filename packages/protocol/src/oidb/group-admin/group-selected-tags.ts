import { decode, message } from '../../protobuf';
import type { OidbNative } from '../../transport';
import { invokeOidb } from '../invoke';
import { requireUint32 } from '../write-validation';

export const GROUP_SELECTED_TAG_LIMIT = 20;

const tagRecordFilter = message([
  { name: 'setterUid', tag: 1, type: 'bytes', force: true },
  { name: 'groupCode', tag: 2, type: 'uint64' },
  { name: 'tagId', tag: 3, type: 'bytes', force: true },
  { name: 'setTime', tag: 4, type: 'uint64' },
  { name: 'goodCount', tag: 5, type: 'uint32' },
  { name: 'badCount', tag: 6, type: 'uint32' },
  { name: 'length', tag: 7, type: 'uint32' },
  { name: 'value', tag: 8, type: 'bytes', force: true },
]);

type Target = { groupId: number };

function groupCode(groupId: number): number {
  const code = requireUint32(groupId, 'groupId');
  if (!code) throw new Error('群号必须为正整数');
  return code;
}

/** Android 从 GroupDetailInfo.tagRecord 初始化群资料编辑器。 */
export namespace GetGroupSelectedTags {
  export const command = 0x88d;
  export const subCommand = 0;
  export const reqSchema = message([
    { name: 'appId', tag: 1, type: 'uint32' },
    {
      name: 'groups',
      tag: 2,
      repeated: true,
      type: message([
        { name: 'groupCode', tag: 1, type: 'uint64' },
        {
          name: 'info',
          tag: 2,
          type: message([
            { name: 'name', tag: 15, type: 'string', force: true },
            { name: 'rawTags', tag: 40, type: 'bytes', force: true },
            { name: 'record', tag: 41, type: tagRecordFilter },
          ]),
        },
      ]),
    },
  ]);
  export const respSchema = message([
    {
      name: 'groups',
      tag: 1,
      repeated: true,
      type: message([
        { name: 'groupCode', tag: 1, type: 'uint64' },
        { name: 'result', tag: 2, type: 'uint32' },
        {
          name: 'info',
          tag: 3,
          type: message([
            { name: 'name', tag: 15, type: 'string' },
            { name: 'rawTags', tag: 40, type: 'bytes' },
            {
              name: 'records',
              tag: 41,
              repeated: true,
              type: message([
                { name: 'groupCode', tag: 2, type: 'uint64' },
                { name: 'value', tag: 8, type: 'string' },
              ]),
            },
          ]),
        },
      ]),
    },
  ]);

  export function serialize(p: Target) {
    const empty = new Uint8Array();
    return {
      appId: 0x20037ec5,
      groups: [
        {
          groupCode: groupCode(p.groupId),
          info: {
            name: '',
            rawTags: empty,
            record: {
              setterUid: empty,
              groupCode: 1n,
              tagId: empty,
              setTime: 1n,
              goodCount: 1,
              badCount: 1,
              length: 1,
              value: empty,
            },
          },
        },
      ],
    };
  }

  export function decodeResponseBody(bytes: Uint8Array) {
    return decode(respSchema, bytes, { strict: true });
  }

  export function deserialize(body: Record<string, unknown>, p: Target): string[] | null {
    const expected = BigInt(p.groupId);
    const rows = ((body.groups ?? []) as Record<string, unknown>[]).filter(
      (row) => row.groupCode === expected,
    );
    if (rows.length !== 1) throw new Error('群标签响应与目标群不一致');
    const row = rows[0]!;
    if (row.result !== undefined && row.result !== 0) throw new Error('QQ 拒绝读取群标签');
    const info = row.info as Record<string, unknown> | undefined;
    if (!info) throw new Error('QQ 未返回群资料');
    const records = (info.records ?? []) as Array<{ groupCode?: bigint; value?: string }>;
    if (records.some((record) => record.groupCode && record.groupCode !== expected))
      throw new Error('群标签记录与目标群不一致');
    if (records.length) {
      if (records.some((record) => !record.value?.trim())) return null;
      return [...new Set(records.map((record) => record.value!))];
    }
    if (info.rawTags instanceof Uint8Array) return info.rawTags.length === 0 ? [] : null;
    // 同一账号用相同选择器实读，空群省略两个标签字段，有标签的群返回原始值与记录。
    // 用明确成功且有群名的群资料确认空集合，保留没有资料的回包为未知。
    return row.result === 0 && typeof info.name === 'string' && info.name.trim() ? [] : null;
  }

  export const invoke = (nt: OidbNative, pid: number, params: Target): Promise<string[] | null> =>
    invokeOidb(nt, pid, GetGroupSelectedTags, params);
}

export namespace SetGroupSelectedTags {
  export const command = 0x89a;
  export const subCommand = 0;
  export const reqSchema = message([
    { name: 'groupCode', tag: 1, type: 'uint64' },
    {
      name: 'info',
      tag: 2,
      type: message([{ name: 'tags', tag: 19, type: 'string', repeated: true }]),
    },
  ]);
  export const respSchema = message([]);
  type Params = Target & { tags: readonly string[] };

  export function serialize(p: Params) {
    if (
      p.tags.length > GROUP_SELECTED_TAG_LIMIT ||
      new Set(p.tags).size !== p.tags.length ||
      p.tags.some((tag) => !tag.trim())
    )
      throw new Error('群标签包含空值、重复值或超过 20 个');
    // 官方清空为 tag 19 的单个空字符串。缺少 tag 19 表示保持原值。
    return { groupCode: groupCode(p.groupId), info: { tags: p.tags.length ? p.tags : [''] } };
  }

  export const deserialize = (): void => {};
  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<void> =>
    invokeOidb(nt, pid, SetGroupSelectedTags, params);
}
