/**
 * 用 `@weqbot/protocol` 实现 OneBot 后端。
 *
 * 只实现协议层**已经覆盖**的能力；其余留 `undefined`，`registerActions`
 * 会自动跳过对应 action（调用返回 1404），不会出现「注册了但一调就崩」。
 *
 * 敏感能力（红包 / 转账）**故意不实现** —— 即使协议层有
 * `packages/protocol/src/redbag/`，它也只对 WeQ 宿主开放，不进 OneBot。
 */

import type {
  FriendInfo,
  GroupInfo,
  GroupMemberInfo,
  LoginInfo,
  OneBotBackend,
  RecallTarget,
  Segment,
  SendResult,
} from '@weqbot/onebot';
import { segmentsToElements } from '@weqbot/onebot';
import type { ProtocolClient } from '@weqbot/protocol';
import {
  FetchGroupList,
  KickGroupMember,
  LeaveGroup,
  MuteGroupAll,
  MuteGroupMember,
  RecallGroup,
  RecallPrivate,
  sendC2cMessage,
  sendGroupMessage,
  sendMessage,
  SendPoke,
  SendProfileLike,
  SetGroupAdmin,
  SetGroupMemberCard,
  SetGroupName,
  type GroupMemberListItem,
  type SendElement,
} from '@weqbot/protocol';
import { fetchAllFriends, fetchAllGroupMembers } from '@weqbot/protocol/contacts';
import type { Logger } from '@weqbot/common';

export interface ProtocolBackendOptions {
  protocol: ProtocolClient;
  selfUin: string;
  selfUid?: string;
  nickname?: string;
  logger?: Logger;
  /** uid ↔ uin 缓存；`@` / 撤回都靠它。 */
  resolveUidUin?: {
    uinByUid(uid: string): string | undefined;
    uidByUin(uin: string): string | undefined;
  };
}

/**
 * 构建后端。
 *
 * 返回的对象**不是**完整的 `OneBotBackend`：只挂上协议能做的那些方法。
 * 列表类接口用 `fetchAll*` 拉全量（分页在协议层封装好了）。
 */
export function createProtocolBackend(options: ProtocolBackendOptions): OneBotBackend {
  const { protocol, selfUin, selfUid, nickname } = options;
  const sessionId = protocol.sessionId;
  const nt = protocol.native;

  async function toElements(segments: Segment[]): Promise<SendElement[]> {
    const elements = await segmentsToElements(segments, {
      resolveMentionUid: (uin) => options.resolveUidUin?.uidByUin(String(uin)) ?? null,
    });
    // `segments.ts` 产出的是「元素形状」，发送侧直接吃它（两边共用同一套字段）。
    return elements as unknown as SendElement[];
  }

  return {
    async getLoginInfo(): Promise<LoginInfo> {
      return {
        userId: Number(selfUin),
        nickname: nickname ?? '',
        ...(selfUid ? { uid: selfUid } : {}),
      };
    },

    async sendGroupMessage(groupId: number, message: Segment[]): Promise<SendResult> {
      const elements = await toElements(message);
      const receipt = await sendGroupMessage(nt, sessionId, groupId, elements);
      if (!receipt.ok) {
        throw new Error(`发送群消息失败：result=${receipt.result} ${receipt.errMsg}`);
      }
      return {
        sequence: receipt.groupSequence,
        clientSequence: receipt.clientSequence,
        random: receipt.random,
        timestamp: receipt.timestamp,
      };
    },

    async sendPrivateMessage(
      userId: number,
      message: Segment[],
      tempGroupId?: number,
    ): Promise<SendResult> {
      const elements = await toElements(message);
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      const receipt = tempGroupId
        ? await sendMessage(nt, sessionId, {
            groupTemp: { groupUin: tempGroupId, toUid: uid ?? '' },
            elements,
          })
        : await sendC2cMessage(nt, sessionId, userId, elements, {
            ...(uid ? { userUid: uid } : {}),
          });
      if (!receipt.ok) {
        throw new Error(`发送私聊消息失败：result=${receipt.result} ${receipt.errMsg}`);
      }
      return {
        sequence: receipt.privateSequence,
        clientSequence: receipt.clientSequence,
        random: receipt.random,
        timestamp: receipt.timestamp,
      };
    },

    async recall(target: RecallTarget): Promise<void> {
      if (target.isGroup) {
        await RecallGroup.invoke(nt, sessionId, {
          groupId: target.targetId,
          sequence: target.sequence,
          random: target.random ?? 0,
        });
        return;
      }
      const uid = options.resolveUidUin?.uidByUin(String(target.targetId));
      if (!uid) throw new Error(`撤回私聊需要对方 uid（${target.targetId} 未观测到）`);
      await RecallPrivate.invoke(nt, sessionId, {
        targetUid: uid,
        clientSequence: target.clientSequence ?? 0,
        messageSequence: target.sequence,
        random: target.random ?? 0,
        timestamp: target.timestamp ?? Math.floor(Date.now() / 1000),
      });
    },

    async getFriendList(): Promise<FriendInfo[]> {
      const { friends } = await fetchAllFriends(nt, sessionId);
      return friends.map(({ friend }) => ({
        userId: friend.uin,
        nickname: friend.nickname,
        remark: friend.remark,
      }));
    },

    async getGroupList(): Promise<GroupInfo[]> {
      const groups = await FetchGroupList.invoke(nt, sessionId);
      return groups.map((group) => ({
        groupId: group.groupId,
        groupName: group.groupName,
        memberCount: group.memberCount,
        maxMemberCount: group.memberMax,
      }));
    },

    async getGroupInfo(groupId: number): Promise<GroupInfo> {
      const groups = await FetchGroupList.invoke(nt, sessionId);
      const group = groups.find((entry) => entry.groupId === groupId);
      if (!group) throw new Error(`没有该群的资料：${groupId}`);
      return {
        groupId: group.groupId,
        groupName: group.groupName,
        memberCount: group.memberCount,
        maxMemberCount: group.memberMax,
      };
    },

    async getGroupMemberList(groupId: number): Promise<GroupMemberInfo[]> {
      const members = await fetchAllGroupMembers(nt, sessionId, groupId);
      return members.map((member) => mapMember(groupId, member));
    },

    async getGroupMemberInfo(groupId: number, userId: number): Promise<GroupMemberInfo> {
      const members = await fetchAllGroupMembers(nt, sessionId, groupId);
      const member = members.find((entry) => entry.uin === userId);
      if (!member) throw new Error(`群 ${groupId} 里没有成员 ${userId}`);
      return mapMember(groupId, member);
    },

    async sendLike(userId: number, times: number): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`点赞需要对方 uid（${userId} 未观测到）`);
      await SendProfileLike.invoke(nt, sessionId, { targetUid: uid, count: times });
    },

    async sendPoke(target: { groupId?: number; userId: number }): Promise<void> {
      await SendPoke.invoke(nt, sessionId, {
        isGroup: target.groupId !== undefined,
        peerUin: target.groupId ?? target.userId,
        targetUin: target.userId,
      });
    },

    async setGroupCard(groupId: number, userId: number, card: string): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`改群名片需要对方 uid（${userId} 未观测到）`);
      await SetGroupMemberCard.invoke(nt, sessionId, { groupId, targetUid: uid, card });
    },

    async setGroupBan(groupId: number, userId: number, duration: number): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`禁言需要对方 uid（${userId} 未观测到）`);
      await MuteGroupMember.invoke(nt, sessionId, { groupId, targetUid: uid, duration });
    },

    async setGroupWholeBan(groupId: number, enable: boolean): Promise<void> {
      await MuteGroupAll.invoke(nt, sessionId, { groupId, enable });
    },

    async setGroupAdmin(groupId: number, userId: number, enable: boolean): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`设管理员需要对方 uid（${userId} 未观测到）`);
      await SetGroupAdmin.invoke(nt, sessionId, { groupId, targetUid: uid, enable });
    },

    async setGroupName(groupId: number, name: string): Promise<void> {
      await SetGroupName.invoke(nt, sessionId, { groupId, name });
    },

    async setGroupKick(groupId: number, userId: number, reject: boolean): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`踢人需要对方 uid（${userId} 未观测到）`);
      await KickGroupMember.invoke(nt, sessionId, { groupId, targetUid: uid, reject });
    },

    async setGroupLeave(groupId: number, _dissolve: boolean): Promise<void> {
      // 解散群是另一条命令（0x1097 只处理退出），这里先只做退出。
      await LeaveGroup.invoke(nt, sessionId, { groupId });
    },
  };
}

function mapMember(groupId: number, member: GroupMemberListItem): GroupMemberInfo {
  return {
    groupId,
    userId: member.uin,
    nickname: member.nickname,
    card: member.card,
    sex: 'unknown',
    age: 0,
    area: '',
    joinTime: member.joinTime,
    lastSentTime: member.lastSentTime,
    level: String(member.level),
    role: member.permission === 1 ? 'owner' : member.permission === 2 ? 'admin' : 'member',
    title: member.specialTitle,
  };
}
