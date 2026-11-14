/**
 * 单向好友列表 — `MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0`。
 *
 * 这条命令**不走标准 OIDB 信封**：请求体是 `{2: 0, 3: JSON}`，直接作为原始
 * SSO 包发出去；响应体里 `{4: JSON}` 是业务数据。所以用 [`TrpcSpec`]（raw
 * command + 自定 schema），不能用 `invokeOidb`。
 *
 * 搬运自 SnowLuma `oidb-services/profile/get-unidirectional-friend-list.ts`
 * （2026-11-13 真机抓包）。JSON 字段保持原样（`uint64_uin` 是**字符串**），
 * 不在这里重新建模 —— 服务端会加字段，透传给调用方比逐字段映射安全。
 *
 * 签名：不在 `SIGN_RULES` 里，三端未实测，已登记进 `UNCONFIRMED_SIGN_COMMANDS`。
 */

import { message } from '../../protobuf';
import { invokeTrpc, type TrpcSpec } from '../invoke';
import type { TrpcNative } from '../../transport';

const REQ = message([
  { name: 'subCommand', tag: 2, type: 'uint32', force: true },
  { name: 'jsonBody', tag: 3, type: 'string' },
]);

const RESP = message([
  { name: 'errorCode', tag: 3, type: 'uint32' },
  { name: 'jsonBody', tag: 4, type: 'string' },
  { name: 'errorMessage', tag: 5, type: 'string' },
]);

/** 服务端返回的条目：字段由服务端决定，保持原始 JSON。 */
export type UnidirectionalFriendEntry = Record<string, unknown>;

export interface GetUnidirectionalFriendListParams {
  /** 自己的 uin（十进制串）；请求里叫 `uint64_uin`。 */
  uin: string;
  /** 单页条数，缺省 99（QQ 客户端的值）。 */
  count?: number;
  /** 续拉游标（服务端原样回填的 cookie）。 */
  cookie?: string;
}

export namespace GetUnidirectionalFriendList {
  /** 命令号（文档用）；**不要**按它拼 `OidbSvcTrpcTcp.*`。 */
  export const opcode = 0xe17;
  /** OIDB 子命令，写在请求体字段 2 里。 */
  const SUB_COMMAND = 0;
  /** 线上命令名：这条是自定义 JSON 传输，不是标准 OIDB 信封。 */
  export const cmd = 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0';

  export const reqSchema = REQ;
  export const respSchema = RESP;

  export function serialize(params: GetUnidirectionalFriendListParams): Record<string, unknown> {
    if (!params.uin.trim()) throw new Error('单向好友列表需要自己的 uin');
    return {
      subCommand: SUB_COMMAND,
      jsonBody: JSON.stringify({
        uint64_uin: params.uin,
        uint64_top: 0,
        uint32_req_num: params.count ?? 99,
        bytes_cookies: params.cookie ?? '',
      }),
    };
  }

  export function deserialize(body: Record<string, unknown>): UnidirectionalFriendEntry[] {
    const errorCode = typeof body.errorCode === 'number' ? body.errorCode : 0;
    if (errorCode) {
      throw new Error(
        `单向好友列表失败：${errorCode} ${typeof body.errorMessage === 'string' ? body.errorMessage : ''}`.trim(),
      );
    }
    if (typeof body.jsonBody !== 'string' || !body.jsonBody) {
      throw new Error('单向好友列表回包为空');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.jsonBody);
    } catch {
      throw new Error('单向好友列表回包不是合法 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('单向好友列表回包结构不正确');
    }

    const payload = parsed as Record<string, unknown>;
    if (payload.ActionStatus !== 'OK' || payload.ErrorCode !== 0) {
      const code = typeof payload.ErrorCode === 'number' ? payload.ErrorCode : '缺失';
      const info = typeof payload.ErrorInfo === 'string' ? payload.ErrorInfo : '';
      throw new Error(`单向好友列表失败：${code} ${info}`.trim());
    }
    if (
      !Array.isArray(payload.rpt_block_list) ||
      !payload.rpt_block_list.every(
        (item) => typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    ) {
      throw new Error('单向好友列表回包缺少 rpt_block_list');
    }
    return payload.rpt_block_list as UnidirectionalFriendEntry[];
  }

  export function invoke(
    nt: TrpcNative,
    sessionId: number,
    params: GetUnidirectionalFriendListParams,
  ): Promise<UnidirectionalFriendEntry[]> {
    return invokeTrpc(
      nt,
      sessionId,
      GetUnidirectionalFriendList as unknown as TrpcSpec<
        GetUnidirectionalFriendListParams,
        UnidirectionalFriendEntry[]
      >,
      params,
    );
  }
}
