import { decode, encode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { ReadedReport } from './read-report';

// 字段对照 acidify 的 SsoReadedReport；私聊使用会话级 NT 序号，不是 clientSeq。
export type ReadReportParams =
  | { kind: 'group'; groupUin: number; sequence: number }
  | { kind: 'c2c'; targetUid: string; sequence: number; timestamp: number }
  | { kind: 'official'; targetUid: string; sequence: 0; timestamp: number };

export type ReadReportTarget =
  | ReadReportParams
  | { kind: 'dataline'; targetUid: string; sequence: 0; timestamp: number };

/** 零序号阅读按原消息时间推进，普通会话按 NT 序号推进。 */
export function readReportWatermark(target: ReadReportTarget): number {
  return target.sequence === 0 && target.kind !== 'group' ? target.timestamp : target.sequence;
}

export namespace ReportRead {
  export const cmd = 'trpc.msg.msg_svc.MsgService.SsoReadedReport';
  // Lagrange.Core 的 PC 签名白名单包含此命令，复用本机 wrapper 签名。
  export const reqSchema = message([
    {
      name: 'group',
      tag: 1,
      type: message([
        { name: 'groupUin', tag: 1, type: 'uint64' },
        { name: 'sequence', tag: 2, type: 'uint64' },
      ]),
    },
    {
      name: 'c2c',
      tag: 2,
      type: message([
        { name: 'targetUid', tag: 2, type: 'string' },
        { name: 'timestamp', tag: 3, type: 'uint64' },
        { name: 'sequence', tag: 4, type: 'uint64', force: true },
      ]),
    },
  ]);

  export function serialize(p: ReadReportTarget): Record<string, unknown> {
    if (
      !Number.isSafeInteger(p.sequence) ||
      (p.kind === 'official' || p.kind === 'dataline' ? p.sequence !== 0 : p.sequence <= 0) ||
      p.sequence > 0xffffffff
    )
      throw new Error('已读上报序号必须是有效的 NT 消息序号。');
    if (p.kind === 'group') {
      if (!Number.isSafeInteger(p.groupUin) || p.groupUin <= 0)
        throw new Error('已读上报群号无效。');
      return { group: { groupUin: BigInt(p.groupUin), sequence: BigInt(p.sequence) } };
    }
    if (
      !/^u_[A-Za-z0-9_-]+$/.test(p.targetUid) ||
      !Number.isSafeInteger(p.timestamp) ||
      p.timestamp <= 0
    )
      throw new Error('私聊已读上报缺少有效 UID 或原消息时间。');
    return {
      c2c: {
        targetUid: p.targetUid,
        timestamp: BigInt(p.timestamp),
        // 原版设备阅读请求没有 tag 4，公众号则显式发送零。
        sequence: p.kind === 'dataline' ? undefined : BigInt(p.sequence),
      },
    };
  }

  /** 空应答符合 NoOutput 服务；未知非空响应不猜成业务成功，也不直接重发。 */
  export async function invoke(
    nt: TrpcNative,
    pid: number,
    params: ReadReportTarget,
  ): Promise<'acknowledged' | 'unconfirmed'> {
    const response = await sendPacket(nt, pid, cmd, encode(reqSchema, serialize(params)));
    if (response.length === 0) return params.sequence === 0 ? 'unconfirmed' : 'acknowledged';
    try {
      const result = ReadedReport.deserialize(
        decode(ReadedReport.respSchema, response, { strict: true }),
      );
      if (result.resultCode !== 0) return 'unconfirmed';
      const row =
        params.kind === 'group'
          ? result.groups.find((item) => item.groupId === params.groupUin)
          : result.c2c.find((item) => item.uid === params.targetUid);
      return row?.resultCode === 0 && (params.kind === 'dataline' || row.readSeq >= params.sequence)
        ? 'acknowledged'
        : 'unconfirmed';
    } catch {
      return 'unconfirmed';
    }
  }
}
