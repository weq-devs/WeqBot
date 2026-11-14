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
  ApproveDoubtFriendRequest,
  CommentGroupAlbumMedia,
  composeGroupFileDownloadUrl,
  CreateGroupFolder,
  DeleteCustomFace,
  DeleteFriend,
  DeleteGroupAlbumMedia,
  DeleteGroupFile,
  DeleteGroupFolder,
  FetchCustomFaceDetail,
  FetchCustomFaceList,
  FetchDoubtFriendRequests,
  FetchGroupList,
  FetchSysFace,
  FetchSysFaces,
  FetchUserProfile,
  GetAlbumMediaList,
  GetEmojiLikes,
  GetGroupAlbumFeedDetail,
  GetGroupAtAllRemain,
  GetGroupFileCount,
  GetGroupFileSpace,
  GetGroupMessagePolicies,
  GetGroupTodoList,
  GetGroupFileUrl,
  GetUnidirectionalFriendList,
  GroupTodo,
  getDressRank,
  getFriendDress,
  getFriendMutualMark,
  getGroupAlbumList,
  getGroupEssencePage,
  getGroupNotice,
  getHonorList,
  getSelfDress,
  getSpecialCare,
  fetchDaySignedList,
  fetchVipInfo,
  HonorType,
  searchDress,
  setGroupNotice,
  deleteGroupNotice,
  uploadGroupNoticeImage,
  uploadGroupAlbumImage,
  uploadGroupAlbumVideo,
  setQzonePublicCommentLike,
  setQzoneBlack,
  setQzoneMsgRight,
  replyQzoneMsg,
  setQzonePublicFollow,
  setQzonePublicLike,
  setQzonePublicUpvote,
  commentQzonePublic,
  replyQzonePublic,
  deleteQzonePublicComment,
  deleteQzonePublicReply,
  forwardQzonePublicFeed,
  HandleFriendRequest,
  KickGroupMember,
  LeaveGroup,
  ListGroupFiles,
  ModifyCustomFace,
  MoveGroupFile,
  MuteGroupAll,
  MuteGroupMember,
  OrderCustomFace,
  parseCustomFaceId,
  RecallGroup,
  RecallPrivate,
  RejectDoubtFriendRequest,
  RenameGroupFile,
  RenameGroupFolder,
  sendC2cMessage,
  sendGroupMessage,
  sendMessage,
  SendGroupSign,
  SendPoke,
  SendProfileLike,
  SetFriendRemark,
  SetGroupAdmin,
  SetGroupAlbumLike,
  SetGroupMemberCard,
  SetGroupName,
  SetReaction,
  SetGroupSpecialTitle,
  TranslateEnToZh,
  getQzoneFeeds,
  getQzoneMsgList,
  getQzoneProfile,
  getQzonePublicCapabilities,
  getQzonePublicComments,
  getQzonePublicFeedDetail,
  getQzonePublicFeeds,
  getQzonePublicReplies,
  commentQzoneMsg,
  deleteQzoneMsg,
  publishQzoneMsg,
  setQzoneLike,
  setQzoneProfile,
  uploadQzoneImage,
  withRetry,
  type GroupMemberListItem,
  type SendElement,
  type WebCredentialSource,
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
  /**
   * web cgi 凭据来源（P8.4）。不给就没有 `qzone` 能力，对应 action 全部 1404。
   * WeqBot 自己的运行时用 `createOidbWebCredentials`；WeQ 注入自己的来源（含免 attach）。
   */
  webCredentials?: WebCredentialSource;
  /** qzone cgi 的域，默认 `qzone.qq.com`。 */
  qzoneDomain?: string;
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

  /**
   * 发送侧的媒体上传上下文。
   *
   * 不带它时，元素里只要有 image / record / video / flashPhoto，协议层会在
   * `resolveMediaContext` 直接抛错（「需要 params.media」）。带上是无害的：
   * 纯文本消息用不到这些字段。
   *
   * `pid` 形参传的是 **sessionId** —— 协议层沿用了搬运时的命名，实际语义就是
   * 会话句柄（见 TODO §13-8 的技术债）。
   */
  function mediaParams() {
    return {
      media: {
        nt,
        pid: sessionId,
        uin: selfUin,
        ...(selfUid ? { selfUid } : {}),
      },
    };
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
      const receipt = await sendGroupMessage(nt, sessionId, groupId, elements, mediaParams());
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
            ...mediaParams(),
          })
        : await sendC2cMessage(nt, sessionId, userId, elements, {
            ...(uid ? { userUid: uid } : {}),
            ...mediaParams(),
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

    async getStrangerInfo(userId: number): Promise<{
      userId: number;
      nickname: string;
      sex: 'male' | 'female' | 'unknown';
      age: number;
    }> {
      const info = await FetchUserProfile.invoke(nt, sessionId, { uin: userId });
      return { userId: info.uin, nickname: info.nickname, sex: info.sex, age: info.age };
    },

    async setFriendAddRequest(flag: string, approve: boolean, _remark: string): Promise<void> {
      // 好友申请的 flag 就是申请方 uid（见 `push/registry.ts` 的 `flag: fromUid`）。
      const uid = flag.trim();
      if (!uid) throw new Error('好友申请 flag 为空');
      await HandleFriendRequest.invoke(nt, sessionId, { targetUid: uid, approve });
    },

    async getStatus(): Promise<{ online: boolean; good: boolean }> {
      // 后端能被调到，本身就说明 session 是 online 的；`good` 留给「链路健康」
      // 这类信息（目前没有独立探针，不假装知道）。
      return { online: true, good: true };
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

    async setGroupSpecialTitle(
      groupId: number,
      userId: number,
      title: string,
      duration?: number,
    ): Promise<void> {
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      if (!uid) throw new Error(`设群头衔需要对方 uid（${userId} 未观测到）`);
      await SetGroupSpecialTitle.invoke(nt, sessionId, {
        groupId,
        targetUid: uid,
        title,
        ...(duration !== undefined ? { expireTime: Math.floor(Date.now() / 1000) + duration } : {}),
      });
    },

    // ─────────────────────── 群文件（P8.2） ───────────────────────

    groupFile: {
      listGroupFiles: async (groupId, directory, startIndex, pageSize) => {
        const page = await ListGroupFiles.invoke(nt, sessionId, {
          groupId,
          targetDirectory: directory || '/',
          startIndex,
          pageSize,
        });
        return page;
      },
      getGroupFileUrl: async (groupId, fileId, busId) => {
        const download = await GetGroupFileUrl.invoke(nt, sessionId, { groupId, fileId, busId });
        return composeGroupFileDownloadUrl(download);
      },
      getGroupFileCount: (groupId) => GetGroupFileCount.invoke(nt, sessionId, { groupId }),
      getGroupFileSpace: (groupId) => GetGroupFileSpace.invoke(nt, sessionId, { groupId }),
      deleteGroupFile: (groupId, fileId) =>
        DeleteGroupFile.invoke(nt, sessionId, { groupId, fileId }),
      renameGroupFile: (groupId, fileId, parentDirectory, newFileName) =>
        RenameGroupFile.invoke(nt, sessionId, {
          groupId,
          fileId,
          parentDirectory,
          newFileName,
        }),
      moveGroupFile: (groupId, fileId, parentDirectory, targetDirectory) =>
        MoveGroupFile.invoke(nt, sessionId, {
          groupId,
          fileId,
          parentDirectory,
          targetDirectory,
        }),
      createGroupFolder: async (groupId, folderName) => {
        const created = await CreateGroupFolder.invoke(nt, sessionId, {
          groupId,
          parentId: '/',
          folderName,
        });
        return created.folderId;
      },
      deleteGroupFolder: (groupId, folderId) =>
        DeleteGroupFolder.invoke(nt, sessionId, { groupId, folderId }),
      renameGroupFolder: (groupId, folderId, newName) =>
        RenameGroupFolder.invoke(nt, sessionId, { groupId, folderId, newFolderName: newName }),
    },

    // ─────────────────────── 收藏表情 ───────────────────────

    customFace: {
      listCustomFaces: () => FetchCustomFaceList.invoke(nt, sessionId, { selfUin }),
      getCustomFaceDetail: async (emojiIds) => {
        const refs = emojiIds.map((emojiId) => parseCustomFaceId(emojiId));
        return FetchCustomFaceDetail.invoke(nt, sessionId, { emojis: refs });
      },
      modifyCustomFace: (emojiId, desc) => {
        const { md5 } = parseCustomFaceId(emojiId);
        return ModifyCustomFace.invoke(nt, sessionId, { emojiId, md5, desc });
      },
      moveCustomFaceToFront: (emojiId) =>
        OrderCustomFace.invoke(nt, sessionId, { emojiId, position: 1 }),
      deleteCustomFace: async (emojiIds) => {
        for (const emojiId of emojiIds) {
          await DeleteCustomFace.invoke(nt, sessionId, { selfUin, emojiId });
        }
      },
    },

    // ─────────────────────── 群待办 ───────────────────────

    groupTodo: {
      setGroupTodo: (groupId, msgSeq) =>
        GroupTodo.invoke(nt, sessionId, { groupId, msgSeq, action: 'set' }),
      completeGroupTodo: (groupId, msgSeq) =>
        GroupTodo.invoke(nt, sessionId, { groupId, msgSeq, action: 'complete' }),
      cancelGroupTodo: (groupId, msgSeq) =>
        GroupTodo.invoke(nt, sessionId, { groupId, msgSeq, action: 'cancel' }),
      getGroupTodoList: async (groupId) => {
        const items = await GetGroupTodoList.invoke(nt, sessionId, { groupId });
        return items.map((item) => ({
          sourceId: item.sourceId,
          sequence: item.sequence,
          random: item.random,
          text: item.text,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          completed: item.completed,
        }));
      },
    },

    // ─────────────────────── 好友关系 ───────────────────────

    friendExtra: {
      deleteFriend: async (userId) => {
        const uid = options.resolveUidUin?.uidByUin(String(userId));
        if (!uid) throw new Error(`删好友需要对方 uid（${userId} 未观测到）`);
        await DeleteFriend.invoke(nt, sessionId, { targetUid: uid });
      },
      setFriendRemark: async (userId, remark) => {
        const uid = options.resolveUidUin?.uidByUin(String(userId));
        if (!uid) throw new Error(`改备注需要对方 uid（${userId} 未观测到）`);
        await SetFriendRemark.invoke(nt, sessionId, { uid, remark });
      },
      getUnidirectionalFriends: () =>
        GetUnidirectionalFriendList.invoke(nt, sessionId, { uin: selfUin }),
      getDoubtFriendRequests: (count) => FetchDoubtFriendRequests.invoke(nt, sessionId, { count }),
      setDoubtFriendRequest: async (flag, approve) => {
        const uid = flag.trim();
        if (!uid) throw new Error('flag 为空');
        if (!approve) {
          await RejectDoubtFriendRequest.invoke(nt, sessionId, { uid });
          return;
        }
        if (!selfUid) throw new Error('同意可疑好友申请需要自己的 uid');
        await ApproveDoubtFriendRequest.invoke(nt, sessionId, { selfUid, targetUid: uid });
      },
    },

    // ─────────────────────── 群策略 / 系统表情 / 回应 ───────────────────────

    groupPolicy: {
      getGroupMessagePolicies: () => GetGroupMessagePolicies.invoke(nt, sessionId),
      getGroupAtAllRemain: (groupId) =>
        GetGroupAtAllRemain.invoke(nt, sessionId, { groupId, selfUin }),
    },

    interactionExtra: {
      getEmojiLikes: (params) => GetEmojiLikes.invoke(nt, sessionId, params),
      setReaction: (params) => SetReaction.invoke(nt, sessionId, params),
      sendGroupSign: async (groupId) => {
        await SendGroupSign.invoke(nt, sessionId, { groupId, selfUin });
      },
      listSystemFaces: async () => {
        const packs = await FetchSysFaces.invoke(nt, sessionId);
        return packs.flatMap((pack) =>
          pack.emojis.map((emoji) => ({
            faceId: Number(emoji.qSid) || 0,
            name: emoji.qDes || emoji.qSid,
            isSuper: emoji.aniStickerType !== null && emoji.aniStickerType !== undefined,
            ...(emoji.emCode ? { emojiId: emoji.emCode } : {}),
          })),
        );
      },
      getSystemFace: async (faceId) => {
        const entry = await FetchSysFace.invoke(nt, sessionId, { faceId });
        if (!entry) return null;
        return {
          faceId: Number(entry.qSid) || faceId,
          name: entry.qDes || entry.qSid,
          isSuper: entry.aniStickerType !== null,
          ...(entry.emCode ? { emojiId: entry.emCode } : {}),
        };
      },
      translateEn2Zh: (words) => TranslateEnToZh.invoke(nt, sessionId, { words }),
    },

    // ─────────────────────── QQ 空间（web cgi） ───────────────────────
    ...(options.webCredentials
      ? {
          qzone: createQzoneBackend({
            source: options.webCredentials,
            domain: options.qzoneDomain ?? 'qzone.qq.com',
            selfUin,
            ...(selfUid ? { selfUid } : {}),
          }),
          ...createGroupWebBackend({
            source: options.webCredentials,
            nt,
            sessionId,
            selfUin,
          }),
        }
      : {}),
  };
}

/** 群公告/相册/荣誉/打卡/精华 + 账号侧装扮/会员（web cgi）。只读走 withRetry。 */
function createGroupWebBackend(options: {
  source: WebCredentialSource;
  nt: ProtocolClient['native'];
  sessionId: number;
  selfUin: string;
}) {
  const { source, nt, sessionId, selfUin } = options;
  const QUN = 'qun.qq.com';
  const QZONE = 'qzone.qq.com';
  const VIP = 'vip.qq.com';
  const TI = 'ti.qq.com';

  const noticeImageUrl = (id: string) =>
    `https://gdynamic.qpic.cn/gdynamic/${encodeURIComponent(id)}/0`;

  async function imageBytes(value: string): Promise<Uint8Array> {
    const trimmed = value.trim();
    const comma = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1;
    const payload = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
    if (comma >= 0 || !/^https?:\/\//i.test(payload)) {
      return new Uint8Array(Buffer.from(payload, 'base64'));
    }
    const response = await fetch(payload);
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  interface AlbumMediaRef {
    batchId: string;
    mediaId: string;
    uploaderUin: string;
    uploadTime: number;
  }

  /** 相册的点赞/评论/删除都要求 batch + uploader + 时间，按 lloc 回查列表。 */
  async function resolveAlbumMedia(
    groupId: number,
    albumId: string,
    batchId?: string,
    lloc?: string,
  ): Promise<AlbumMediaRef> {
    let attach = '';
    for (let page = 0; page < 20; page += 1) {
      const body = (await GetAlbumMediaList.invoke(nt, sessionId, {
        groupId: String(groupId),
        albumId,
        attachInfo: attach,
      })) as { data?: { mediaList?: Array<Record<string, unknown>>; nextAttachInfo?: string } };
      for (const item of body.data?.mediaList ?? []) {
        const image = (item.image ?? {}) as Record<string, unknown>;
        const video = (item.video ?? {}) as Record<string, unknown>;
        const mediaId = String(video.id ?? image.lloc ?? '');
        const itemBatch = String(item.batchId ?? '');
        if (batchId && itemBatch !== batchId) continue;
        if (lloc && mediaId !== lloc) continue;
        if (!mediaId) continue;
        return {
          batchId: itemBatch,
          mediaId,
          uploaderUin: String(item.uploader ?? ''),
          uploadTime: Number(item.uploadTime ?? 0),
        };
      }
      attach = String(body.data?.nextAttachInfo ?? '');
      if (!attach) break;
    }
    throw new Error('相册里找不到对应媒体（先调 get_group_album_media_list 拿 lloc/batch_id）');
  }

  return {
    groupNotice: {
      async getGroupNotice(groupId: number) {
        const list = await withRetry(source, QUN, (cred) => getGroupNotice(cred, String(groupId)));
        return list.map((notice) => {
          const image = notice.images.map((pic) => ({
            id: pic.id,
            url: noticeImageUrl(pic.id),
            width: pic.width,
            height: pic.height,
          }));
          return {
            notice_id: notice.noticeId,
            sender_id: notice.senderId,
            publish_time: notice.publishTime,
            message: { text: notice.text, image, images: image },
            // 这个 cgi 不返回置顶/类型/已读设置；不要猜，保留中性值。
            settings: null,
            read_num: notice.readNum,
            type: 0,
            pinned: 0,
            send_to_new_members: false,
          };
        });
      },
      async sendGroupNotice(params: {
        groupId: number;
        content: string;
        image?: string;
        pinned?: number;
        type?: number;
        sendToNewMembers?: boolean;
        isShowEditCard?: number;
        tipWindowType?: number;
        confirmRequired?: number;
      }) {
        let uploaded: { id: string; width: number; height: number } | undefined;
        if (params.image) {
          const bytes = await imageBytes(params.image);
          uploaded = await withRetry(source, QUN, (cred) => uploadGroupNoticeImage(cred, bytes));
        }
        const cred = await source.forDomain(QUN);
        await setGroupNotice(cred, String(params.groupId), params.content, {
          ...(params.pinned !== undefined ? { pinned: params.pinned as 0 | 1 } : {}),
          ...(params.type !== undefined ? { type: params.type } : {}),
          ...(params.sendToNewMembers !== undefined
            ? { sendToNewMembers: params.sendToNewMembers }
            : {}),
          ...(params.isShowEditCard !== undefined
            ? { isShowEditCard: params.isShowEditCard as 0 | 1 }
            : {}),
          ...(params.tipWindowType !== undefined
            ? { tipWindowType: params.tipWindowType as 0 | 1 }
            : {}),
          ...(params.confirmRequired !== undefined
            ? { confirmRequired: params.confirmRequired as 0 | 1 }
            : {}),
          ...(uploaded
            ? { picId: uploaded.id, imgWidth: uploaded.width, imgHeight: uploaded.height }
            : {}),
        });
      },
      async deleteGroupNotice(groupId: number, fid: string) {
        const cred = await source.forDomain(QUN);
        await deleteGroupNotice(cred, String(groupId), fid);
      },
    },

    groupAlbum: {
      async listAlbums(groupId: number) {
        const list = await withRetry(source, QZONE, (cred) =>
          getGroupAlbumList(cred, String(groupId)),
        );
        return list.map((album) => ({
          id: album.id,
          name: album.title,
          picNum: album.photoCount,
          createTime: Math.floor(Date.parse(album.createTime) / 1000) || 0,
          last_upload_time: Math.floor(Date.parse(album.updateTime) / 1000) || 0,
          cover: album.coverUrl
            ? {
                type: 0,
                image: {
                  name: '',
                  sloc: '',
                  lloc: '',
                  photoUrls: [],
                  defaultUrl: { url: album.coverUrl, width: 0, height: 0 },
                  isGif: false,
                  hasRaw: false,
                },
              }
            : null,
          createuin: String(album.createUin),
          createnickname: album.createNickname,
        }));
      },
      async uploadImage(params: {
        groupId: number;
        albumId: string;
        albumName: string;
        image: Uint8Array;
        fileName?: string;
      }) {
        const cred = await source.forDomain(QZONE);
        return uploadGroupAlbumImage(cred, {
          groupId: String(params.groupId),
          albumId: params.albumId,
          albumName: params.albumName,
          image: params.image,
          ...(params.fileName ? { fileName: params.fileName } : {}),
        });
      },
      async uploadVideo(params: {
        groupId: number;
        albumId: string;
        albumName: string;
        video: Uint8Array | string;
        cover: Uint8Array;
        durationMs: number;
        width: number;
        height: number;
        fileName: string;
      }) {
        const cred = await source.forDomain(QZONE);
        return uploadGroupAlbumVideo(cred, {
          groupId: String(params.groupId),
          albumId: params.albumId,
          albumName: params.albumName,
          video: params.video,
          cover: params.cover,
          durationMs: params.durationMs,
          width: params.width,
          height: params.height,
          fileName: params.fileName,
          beforeSend: () => {},
        });
      },
      async listMedia(groupId: number, albumId: string, attachInfo: string) {
        const body = (await GetAlbumMediaList.invoke(nt, sessionId, {
          groupId: String(groupId),
          albumId,
          attachInfo,
        })) as {
          data?: { mediaList?: unknown[]; nextAttachInfo?: string };
        };
        return {
          mediaList: body.data?.mediaList ?? [],
          nextAttachInfo: String(body.data?.nextAttachInfo ?? ''),
        };
      },
      async comment(params: {
        groupId: number;
        albumId: string;
        lloc: string;
        content: string;
        batchId?: string;
      }) {
        const media = await resolveAlbumMedia(
          params.groupId,
          params.albumId,
          params.batchId,
          params.lloc,
        );
        const cells = await GetGroupAlbumFeedDetail.invoke(nt, sessionId, {
          groupId: String(params.groupId),
          albumId: params.albumId,
          batchId: media.batchId,
          lloc: params.lloc,
        });
        const result = await CommentGroupAlbumMedia.invoke(nt, sessionId, {
          groupId: String(params.groupId),
          selfUin,
          cells,
          content: params.content,
        });
        return {
          id: result.id,
          user: { uin: selfUin },
          content: [{ type: 0, content: params.content }],
          time: String(result.time),
          clientKey: result.clientKey,
        };
      },
      async setLike(params: {
        groupId: number;
        albumId: string;
        batchId: string;
        lloc?: string;
        like: boolean;
      }) {
        const media = await resolveAlbumMedia(
          params.groupId,
          params.albumId,
          params.batchId,
          params.lloc,
        );
        await SetGroupAlbumLike.invoke(nt, sessionId, {
          groupId: String(params.groupId),
          albumId: params.albumId,
          batchId: media.batchId,
          uploaderUin: media.uploaderUin,
          uploadTime: media.uploadTime,
          mediaId: media.mediaId,
          selfUin,
          like: params.like,
        });
        return { id: media.mediaId, status: params.like ? 0 : 1 };
      },
      async deleteMedia(params: {
        groupId: number;
        albumId: string;
        lloc: string;
        batchId?: string;
      }) {
        const media = await resolveAlbumMedia(
          params.groupId,
          params.albumId,
          params.batchId,
          params.lloc,
        );
        await DeleteGroupAlbumMedia.invoke(nt, sessionId, {
          groupId: String(params.groupId),
          albumId: params.albumId,
          mediaIds: [params.lloc],
          batchIds: [media.batchId],
        });
      },
    },

    groupHonor: {
      async getGroupHonor(
        groupId: number,
        type: 'all' | 'talkative' | 'performer' | 'legend' | 'emotion',
      ) {
        const wanted =
          type === 'all'
            ? (['talkative', 'performer', 'legend', 'emotion'] as const)
            : ([type] as const);
        const byType = new Map(
          await Promise.all(
            wanted.map(async (name) => {
              const honor =
                name === 'talkative'
                  ? HonorType.Talkative
                  : name === 'performer'
                    ? HonorType.Performer
                    : name === 'legend'
                      ? HonorType.Legend
                      : HonorType.Emotion;
              const list = await withRetry(source, QUN, (cred) =>
                getHonorList(cred, String(groupId), honor),
              );
              return [name, list] as const;
            }),
          ),
        );
        const map = (name: 'talkative' | 'performer' | 'legend' | 'emotion') =>
          (byType.get(name) ?? []).map((member) => ({
            user_id: member.uin,
            nickname: member.nickname,
            avatar: member.avatar,
            description: member.description,
          }));
        const talkative = map('talkative');
        return {
          current_talkative: talkative[0] ?? null,
          talkative_list: talkative,
          performer_list: map('performer'),
          legend_list: map('legend'),
          emotion_list: map('emotion'),
        };
      },
    },

    groupSignin: {
      getSignedList: (params: {
        groupId: number;
        dayYmd?: string;
        offset?: number;
        limit?: number;
      }) =>
        withRetry(source, QUN, (cred) =>
          fetchDaySignedList(cred, {
            groupId: String(params.groupId),
            ...(params.dayYmd ? { dayYmd: params.dayYmd } : {}),
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          }),
        ),
    },

    groupEssence: {
      async getEssence(groupId: number, pageStart: number, pageLimit: number) {
        const page = await withRetry(source, QUN, (cred) =>
          getGroupEssencePage(cred, String(groupId), pageStart, pageLimit),
        );
        const messages = page.messages.map((message) => ({
          msg_seq: message.msg_seq,
          msg_random: message.msg_random,
          sender_id: Number(message.sender_uin),
          sender_nick: message.sender_nick,
          sender_time: message.sender_time,
          operator_id: Number(message.add_digest_uin),
          operator_nick: message.add_digest_nick,
          operator_time: message.add_digest_time,
          content: message.msg_content.map((part) =>
            part.text
              ? { type: 'text', data: { text: part.text } }
              : part.image_url
                ? { type: 'image', data: { file: part.image_url } }
                : { type: 'text', data: { text: '' } },
          ),
          can_be_removed: message.can_be_removed,
        }));
        return { messages, complete: page.complete };
      },
    },

    accountWeb: {
      getSelfDress: () => withRetry(source, VIP, (cred) => getSelfDress(cred)),
      getVipInfo: () => withRetry(source, VIP, (cred) => fetchVipInfo(cred)),
      getSpecialCare: () => withRetry(source, QZONE, (cred) => getSpecialCare(cred)),
      getFriendDress: (targetUin: number) =>
        withRetry(source, VIP, (cred) => getFriendDress(cred, String(targetUin))),
      getFriendMutualMark: (targetUin: number) =>
        withRetry(source, TI, (cred) => getFriendMutualMark(cred, String(targetUin))),
      getDressRank: (appId: number, pageIndex?: number, pageSize?: number) =>
        withRetry(source, VIP, (cred) =>
          getDressRank(cred, {
            appId: appId as never,
            pageIndex: pageIndex ?? 1,
            pageSize: pageSize ?? 20,
          }),
        ),
      searchDress: (appId: number, keyword: string, pageIndex?: number, pageSize?: number) =>
        withRetry(source, VIP, (cred) =>
          searchDress(cred, {
            appId: appId as never,
            keyword,
            pageIndex: pageIndex ?? 0,
            pageSize: pageSize ?? 40,
          }),
        ),
    },
  };
}

/** qzone 后端：读走 withRetry，写只换一次票、不重放（避免重复写）。 */
function createQzoneBackend(options: {
  source: WebCredentialSource;
  domain: string;
  selfUin: string;
  selfUid?: string;
}) {
  const { source, domain, selfUin, selfUid } = options;
  const target = (uin: number | undefined) => String(uin ?? selfUin);
  const selfUser = { uin: selfUin, ...(selfUid ? { uid: selfUid } : {}) };

  return {
    async getProfile(uin?: number) {
      return withRetry(source, domain, (cred) => getQzoneProfile(cred, selfUin, target(uin)));
    },
    async setProfile(patch: { name?: string; description?: string }) {
      const cred = await source.forDomain(domain);
      await setQzoneProfile(cred, selfUin, patch);
    },
    async getMsgList(uin: number | undefined, pos: number, num: number) {
      const result = await withRetry(source, domain, (cred) =>
        getQzoneMsgList(cred, target(uin), pos, num),
      );
      return { total: result.total, list: result.list };
    },
    async getFeeds(pageNum: number, count: number, cursor?: string) {
      return withRetry(source, domain, (cred) =>
        getQzoneFeeds(cred, selfUin, pageNum, count, undefined, cursor),
      );
    },
    async setLike(uin: number | undefined, tid: string, like: boolean) {
      const cred = await source.forDomain(domain);
      await setQzoneLike(cred, target(uin), tid, like);
    },
    async comment(uin: number | undefined, tid: string, content: string) {
      const cred = await source.forDomain(domain);
      return commentQzoneMsg(cred, target(uin), tid, content);
    },
    async reply(
      uin: number | undefined,
      tid: string,
      replyTarget: {
        commentId: string;
        commentUin: string;
        replyTo?: { uin: string; name: string };
      },
      content: string,
    ) {
      const cred = await source.forDomain(domain);
      return replyQzoneMsg(cred, target(uin), tid, replyTarget, content);
    },
    async setMsgRight(
      uin: number | undefined,
      tid: string,
      ugcRight: number,
      targetUins?: string[],
    ) {
      const cred = await source.forDomain(domain);
      return setQzoneMsgRight(cred, target(uin), tid, ugcRight, targetUins);
    },
    async setBan(userId: number, enable: boolean) {
      const cred = await source.forDomain(domain);
      await setQzoneBlack(cred, String(userId), enable);
    },
    async publish(content: string, images: string[], ugcRight?: number, targetUins?: string[]) {
      const cred = await source.forDomain(domain);
      const richvals: string[] = [];
      for (const image of images) {
        const uploaded = await uploadQzoneImage(cred, image);
        richvals.push(uploaded.richval);
      }
      const result = await publishQzoneMsg(
        cred,
        content,
        richvals,
        (ugcRight ?? 1) as 1 | 4 | 16 | 64 | 128,
        targetUins,
      );
      return { tid: result.tid, time: result.time };
    },
    async deleteMsg(uin: number | undefined, tid: string) {
      const cred = await source.forDomain(domain);
      await deleteQzoneMsg(cred, target(uin), tid);
    },
    getPublicCapabilities: () =>
      withRetry(source, domain, (cred) => getQzonePublicCapabilities(cred)),
    getPublicFeeds: (cursor?: string) =>
      withRetry(source, domain, (cred) => getQzonePublicFeeds(cred, cursor)),
    getPublicFeedDetail: (feed: Record<string, unknown>) =>
      withRetry(source, domain, (cred) => getQzonePublicFeedDetail(cred, feed as never)),
    getPublicComments: (feed: Record<string, unknown>, cursor: string) =>
      withRetry(source, domain, (cred) => getQzonePublicComments(cred, feed as never, cursor)),
    getPublicReplies: (
      feed: Record<string, unknown>,
      comment: Record<string, unknown>,
      cursor?: string,
      pageSize?: number,
    ) =>
      withRetry(source, domain, (cred) =>
        getQzonePublicReplies(cred, feed as never, comment as never, cursor ?? '', pageSize),
      ),
    async setPublicUpvote(feed: Record<string, unknown>, enable: boolean) {
      const cred = await source.forDomain(domain);
      return setQzonePublicUpvote(cred, feed as never, enable);
    },
    async setPublicLike(feed: Record<string, unknown>, enable: boolean) {
      const cred = await source.forDomain(domain);
      return setQzonePublicLike(cred, feed as never, enable);
    },
    async setPublicCommentLike(
      feed: Record<string, unknown>,
      comment: Record<string, unknown>,
      reply: Record<string, unknown> | undefined,
      enable: boolean,
    ) {
      const cred = await source.forDomain(domain);
      return setQzonePublicCommentLike(
        cred,
        feed as never,
        comment as never,
        enable,
        reply as never,
      );
    },
    async commentPublic(feed: Record<string, unknown>, content: string) {
      const cred = await source.forDomain(domain);
      return commentQzonePublic(cred, feed as never, selfUser as never, content);
    },
    async replyPublic(
      feed: Record<string, unknown>,
      comment: Record<string, unknown>,
      content: string,
      reply?: Record<string, unknown>,
    ) {
      const cred = await source.forDomain(domain);
      return replyQzonePublic(
        cred,
        feed as never,
        selfUser as never,
        comment as never,
        content,
        reply as never,
      );
    },
    async deletePublicComment(feed: Record<string, unknown>, comment: Record<string, unknown>) {
      const cred = await source.forDomain(domain);
      await deleteQzonePublicComment(cred, feed as never, comment as never);
    },
    async deletePublicReply(
      feed: Record<string, unknown>,
      comment: Record<string, unknown>,
      reply: Record<string, unknown>,
    ) {
      const cred = await source.forDomain(domain);
      await deleteQzonePublicReply(cred, feed as never, comment as never, reply as never);
    },
    async setPublicFollow(feed: Record<string, unknown>, enable: boolean) {
      const cred = await source.forDomain(domain);
      return setQzonePublicFollow(cred, feed as never, enable);
    },
    async forwardPublicFeed(feed: Record<string, unknown>, reason: string) {
      const cred = await source.forDomain(domain);
      return forwardQzonePublicFeed(cred, feed as never, reason);
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
