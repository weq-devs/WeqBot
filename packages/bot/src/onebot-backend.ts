/**
 * 用 `@weqbot/protocol` 实现 OneBot 后端。
 *
 * 只实现协议层**已经覆盖**的能力；其余留 `undefined`，`registerActions`
 * 会自动跳过对应 action（调用返回 1404），不会出现「注册了但一调就崩」。
 *
 * 敏感能力（红包 / 转账）**故意不实现** —— 即使协议层有
 * `packages/protocol/src/redbag/`，它也只对 WeQ 宿主开放，不进 OneBot。
 */

import { readFile } from 'node:fs/promises';
import type {
  ForwardMessageNode,
  ForwardNode,
  ForwardPreview,
  FriendInfo,
  GroupInfo,
  GroupMemberInfo,
  HistoryMessage,
  InboundElement,
  LoginInfo,
  OneBotBackend,
  ProfileLikeUserInfo,
  RecallTarget,
  Segment,
  SendResult,
} from '@weqbot/onebot';
import { elementsToSegments, NotImplementedError, segmentsToElements } from '@weqbot/onebot';
import type { ProtocolClient } from '@weqbot/protocol';
import {
  AddCustomFace,
  ApproveDoubtFriendRequest,
  ClickInlineKeyboardButton,
  CommentGroupAlbumMedia,
  decodeMessageBody,
  fetchC2cHistoryRaw,
  fetchForwardRaw,
  fetchGroupHistoryRaw,
  ReadedReport,
  sendForward as sendLongMessage,
  sendGroupFile,
  sendPrivateFile,
  type ForwardNode as ProtocolForwardNode,
  type RawMessageBody,
  composeGroupFileDownloadUrl,
  CreateGroupFolder,
  DeleteCustomFace,
  DeleteFriend,
  DeleteFlashFile,
  DeleteGroupAlbumMedia,
  DeleteGroupFile,
  DeleteGroupFolder,
  FetchAiVoiceList,
  cleanNtLocalPath,
  SetInputStatus,
  SetSelfLongNick,
  FetchCustomFaceDetail,
  FetchCustomFaceList,
  FetchDoubtFriendRequests,
  AddGroupCategoryTag,
  DeleteGroupCategoryTag,
  FetchFilteredGroupRequests,
  FetchGroupDetail,
  FetchGroupExtInfo,
  FetchGroupList,
  FetchGroupRequests,
  FetchSysFace,
  GetAdminPermissions,
  GetGroupCategoryTags,
  ModifyGroupExtInfo,
  SetAdminPermissions,
  SetAdminReceiveVerify,
  SetGroupAddOption,
  SetGroupRequest,
  SetGroupInvitePolicy,
  SetGroupHistoryVisibility,
  SetGroupMemberPermission,
  SetGroupSearch,
  TransGroupFile,
  decodeGroupHistoryVisibility,
  decodeGroupMemberPermissions,
  decodeMemberInvitePolicy,
  setGroupAvatar,
  FetchDownloadRkeys,
  FetchSysFaces,
  FetchUserProfile,
  GetAlbumMediaList,
  GetBuddyRecommendArk,
  GetEmojiLikes,
  GetGroupAlbumFeedDetail,
  GetGroupRecommendArk,
  GetGroupAtAllRemain,
  GetGroupFileCount,
  GetGroupShareLink,
  GetMiniAppArk,
  GroupGiftPanel,
  GetGroupFileSpace,
  GetGroupMessagePolicies,
  GetGroupPttUrl,
  GetGroupTodoList,
  GetGroupFileUrl,
  GetPrivateFileUrl,
  GetProfileLike,
  GetQqShowUrl,
  GetFilesetDetail,
  GetFlashDownload,
  GetFlashDownloadUrl,
  GetUnidirectionalFriendList,
  GroupTodo,
  buildShareLocationElements,
  getBubbleResources,
  getDressRank,
  getFontResource,
  getFriendDress,
  getFriendMutualMark,
  getCollectionList,
  getGroupAlbumList,
  getGroupEssencePage,
  getGroupNotice,
  getHonorList,
  getPendantResources,
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
  ListFilesets,
  ListGroupFiles,
  ModifyCustomFace,
  MoveGroupFile,
  MuteGroupAll,
  MuteGroupMember,
  OrderCustomFace,
  parseCustomFaceId,
  RecallGroup,
  RecallPrivate,
  RequestDecryptKey,
  RejectDoubtFriendRequest,
  RenameFlashFile,
  RenameGroupFile,
  RenameGroupFolder,
  sendC2cMessage,
  sendGroupMessage,
  sendMessage,
  SendAiVoice,
  SendFlashMsg,
  SendGroupSign,
  SendPoke,
  SendProfileLike,
  SendTuwenArk,
  SetDiyOnlineStatus,
  SetFriendCategory,
  SetFriendRemark,
  SetGroupAdmin,
  SetGroupEssence,
  SetGroupAlbumLike,
  SetGroupMemberCard,
  SetGroupName,
  SetGroupRemark,
  SetOnlineStatus,
  SetReaction,
  SetSelfProfile,
  setSelfAvatar,
  SetGroupSpecialTitle,
  StartLocationShare,
  ReportLocation,
  TranslateEnToZh,
  getQzoneFeedDetail,
  getQzoneFeeds,
  getQzoneHomeFeeds,
  getQzoneMsgDetail,
  getQzoneShareArk,
  getQzoneMsgList,
  getQzoneProfile,
  getQzonePublicCapabilities,
  getQzonePublicComments,
  getQzonePublicFeedDetail,
  getQzonePublicFeeds,
  getQzonePublicReplies,
  commentQzoneMsg,
  deleteQzoneMsg,
  fetchGiftMallAIDiscStatus,
  fetchGiftMallGiftList,
  fetchGiftMallHomePageExtraInfo,
  fetchGiftMallSingleGiftInfo,
  fetchGiftMallVipInfo,
  fetchGiftMallWall,
  buildGiftMallSendRequest,
  forwardQzoneMsg,
  submitGiftMallBuyItem,
  searchGiftMall,
  publishQzoneMsg,
  setQzoneLike,
  setQzoneProfile,
  uploadFlashFiles,
  uploadQzoneImage,
  withRetry,
  type GroupMemberListItem,
  type GroupRequest,
  type GroupRequestPage,
  type LikeUserInfo,
  type MediaIndexNode,
  type PublicProfileFields,
  type SendElement,
  type WebCredentialSource,
} from '@weqbot/protocol';
import { fetchAllFriends, fetchAllGroupMembers } from '@weqbot/protocol/contacts';
import type { Logger } from '@weqbot/common';
import { parseGroupRequestFlag, type ParsedGroupRequestFlag } from './group-request-flag';

export interface ProtocolBackendOptions {
  protocol: ProtocolClient;
  selfUin: string;
  selfUid?: string;
  nickname?: string;
  logger?: Logger;
  /**
   * 历史 / 合并转发消息里的媒体 URL 解析（与适配层入站事件同一份实现）。
   * 不传时图片 / 语音段只有文件名，`url` 为空。
   */
  imageUrlResolver?: (
    element: Record<string, unknown>,
    isGroup: boolean,
  ) => Promise<string> | string;
  mediaUrlResolver?: (
    element: Record<string, unknown>,
    isGroup: boolean,
  ) => Promise<string> | string;
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
  /** `bot_exit` 的优雅下线回调；由 `createBot` 注入。 */
  shutdown?: (reason: string) => Promise<void>;
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

  // ─────────────── 历史 / 合并转发 / 已读（第 1 批） ───────────────
  //
  // 行走窗口的常量与 SnowLuma `core/src/bridge/apis/message.ts` 一致：小包、
  // 有上限的请求数、请求之间留 300ms。服务端历史是现拉现转，不落盘。

  const selfId = Number(selfUin);
  const HISTORY_MAX_COUNT = 200;
  const HISTORY_CHUNK_SEQ = 30;
  const HISTORY_MAX_REQUESTS = 12;
  const HISTORY_GAP_MS = 300;
  const UINT32_MAX = 0xffffffff;

  let lastHistoryAt = 0;
  /** 历史请求节流：协议层不管限速，这里统一排队。 */
  async function historyGate<T>(run: () => Promise<T>): Promise<T> {
    const wait = lastHistoryAt + HISTORY_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastHistoryAt = Date.now();
    return run();
  }

  function historyLimit(count: number): number {
    const value = Math.trunc(count) || 20;
    return Math.min(Math.max(1, value), HISTORY_MAX_COUNT);
  }

  /** QQ 把已删除 / body 为空的漫游记录留成「无发送者且无时间」的空壳，跳过。 */
  function isNullRoamRecord(raw: RawMessageBody): boolean {
    return (raw.responseHead?.fromUin ?? 0) <= 0 && (raw.contentHead?.timestamp ?? 0) <= 0;
  }

  function segmentResolvers() {
    return {
      ...(options.imageUrlResolver ? { imageUrlResolver: options.imageUrlResolver as never } : {}),
      ...(options.mediaUrlResolver ? { mediaUrlResolver: options.mediaUrlResolver as never } : {}),
    };
  }

  // ─────────────── 加群请求：flag → 0x10C8 的四元组（第 1 批补齐） ───────────────
  //
  // 一次最多两个 OIDB（主 / 过滤收件箱），每个最多翻 GROUP_REQUEST_MAX_PAGES 页；
  // 判断与 SnowLuma 的 `fetchRequestInboxes` 同口径：两个收件箱都失败才算失败，
  // 单个失败只影响能不能匹配到。

  interface ResolvedGroupRequest {
    sequence: number;
    groupId: number;
    eventType: number;
    filtered: boolean;
    operateTransInfo?: Uint8Array;
  }

  const GROUP_REQUESTS_PER_PAGE = 50;
  const GROUP_REQUEST_MAX_PAGES = 10;

  async function fetchGroupRequestInbox(filtered: boolean): Promise<GroupRequest[]> {
    const out: GroupRequest[] = [];
    let cookie: number | bigint = 0;
    for (let page = 0; page < GROUP_REQUEST_MAX_PAGES; page += 1) {
      const result: GroupRequestPage = filtered
        ? await FetchFilteredGroupRequests.invoke(nt, sessionId, {
            count: GROUP_REQUESTS_PER_PAGE,
            cookie,
          })
        : await FetchGroupRequests.invoke(nt, sessionId, {
            count: GROUP_REQUESTS_PER_PAGE,
            cookie,
          });
      out.push(...result.requests);
      if (result.cookie === 0 || result.requests.length < GROUP_REQUESTS_PER_PAGE) break;
      cookie = result.cookie;
    }
    return out;
  }

  /** 主 + 过滤收件箱一起拉；两个都失败才抛，单个失败只记日志。 */
  async function fetchGroupRequestInboxes(): Promise<{
    requests: GroupRequest[];
    failures: unknown[];
  }> {
    const [main, filtered] = await Promise.allSettled([
      fetchGroupRequestInbox(false),
      fetchGroupRequestInbox(true),
    ]);
    const failures: unknown[] = [];
    if (main.status === 'rejected') {
      failures.push(main.reason);
      options.logger?.warn('拉取加群请求主收件箱失败', { cause: main.reason });
    }
    if (filtered.status === 'rejected') {
      failures.push(filtered.reason);
      options.logger?.warn('拉取加群请求过滤收件箱失败', { cause: filtered.reason });
    }
    if (failures.length === 2) {
      throw new Error('加群请求的主 / 过滤收件箱都拉取失败', { cause: failures[0] });
    }
    return {
      requests: [
        ...(main.status === 'fulfilled' ? main.value : []),
        ...(filtered.status === 'fulfilled' ? filtered.value : []),
      ],
      failures,
    };
  }

  function groupRequestSubType(request: GroupRequest): 'add' | 'invite' | undefined {
    // 1 = 入群申请；2 = 别人邀请我（SnowLuma 的 `isSelfGroupInvitation`）；22 = 邀请。
    if (request.eventType === 1) return 'add';
    if (request.eventType === 2 || request.eventType === 22) return 'invite';
    return undefined;
  }

  function missingGroupRequest(message: string, failures: unknown[]): never {
    if (failures.length > 0) {
      throw new Error(`加群请求查找不完整：${message}`, { cause: failures[0] });
    }
    throw new Error(message);
  }

  /**
   * `slreq:` 规范形态：四元组已经有了，只在需要 `operateTransInfo` 时回查一次。
   *
   * 回查失败不算错 —— 没有透传字段也能发审批（SnowLuma 同样在 `!live` 时原样用 flag）。
   */
  async function resolveLiveGroupRequest(
    handle: ResolvedGroupRequest,
  ): Promise<ResolvedGroupRequest> {
    try {
      const { requests } = await fetchGroupRequestInboxes();
      const live = requests.find(
        (request) => request.groupId === handle.groupId && request.sequence === handle.sequence,
      );
      if (!live) return handle;
      return {
        sequence: live.sequence,
        groupId: live.groupId,
        eventType: live.eventType,
        filtered: live.filtered,
        ...(live.operateTransInfo ? { operateTransInfo: live.operateTransInfo } : {}),
      };
    } catch {
      // 透传字段是可选的；拿不到就用 flag 里的四元组直接发。
      return handle;
    }
  }

  /** 裸序号 / `add:` / `invite:` → 去收件箱找出唯一匹配的那一条。 */
  async function resolveGroupRequestFromInbox(
    parsed: Exclude<ParsedGroupRequestFlag, { kind: 'canonical' }>,
  ): Promise<ResolvedGroupRequest> {
    const { requests, failures } = await fetchGroupRequestInboxes();

    if (parsed.kind === 'sequence') {
      const match = requests.find((request) => request.sequence === parsed.sequence);
      if (!match) {
        missingGroupRequest(`收件箱里没有序号 ${parsed.sequence} 的加群请求`, failures);
      }
      if (!groupRequestSubType(match)) {
        missingGroupRequest(
          `序号 ${parsed.sequence} 不是加群 / 邀请请求（eventType=${match.eventType}）`,
          failures,
        );
      }
      return {
        sequence: match.sequence,
        groupId: match.groupId,
        eventType: match.eventType,
        filtered: match.filtered,
        ...(match.operateTransInfo ? { operateTransInfo: match.operateTransInfo } : {}),
      };
    }

    // legacy：群号 + 申请人 uid（推送里只有这两个）。只看待处理的（state === 1）。
    const candidates = requests.filter((request) => {
      if (request.groupId !== parsed.groupId || request.state !== 1) return false;
      if (groupRequestSubType(request) !== parsed.requestType) return false;
      // 入群申请看 target（申请人）；邀请看 invitor（邀请人）。
      return parsed.requestType === 'add'
        ? request.target.uid === parsed.targetUid
        : request.invitor.uid === parsed.targetUid;
    });

    if (candidates.length === 0) {
      missingGroupRequest(
        `群里没有匹配待处理请求（group=${parsed.groupId} kind=${parsed.requestType} uid=${parsed.targetUid}）`,
        failures,
      );
    }
    const match = candidates[0]!;
    // 多条待处理请求同名同号时不能猜：宁可让调用方拿更精确的 flag 重来。
    if (
      candidates.some(
        (request) =>
          request.sequence !== match.sequence ||
          request.eventType !== match.eventType ||
          request.filtered !== match.filtered,
      )
    ) {
      throw new Error(
        `群 ${parsed.groupId} 有多条待处理请求匹配这个 flag，无法确定处理哪一条（请改用 get_group_system_msg 的 flag）`,
      );
    }
    return {
      sequence: match.sequence,
      groupId: match.groupId,
      eventType: match.eventType,
      filtered: match.filtered,
      ...(match.operateTransInfo ? { operateTransInfo: match.operateTransInfo } : {}),
    };
  }

  /**
   * 已读探测：只报 0 水位，读回会话当前 read/latest 对（不推进任何标记）。
   * `SsoReadedReport` 是历史分页唯一不依赖本地存储的锚点来源。
   */
  async function latestGroupSequence(groupId: number): Promise<number> {
    const probe = await ReadedReport.invoke(nt, sessionId, {
      groups: [{ groupId, lastReadSeq: 0 }],
    });
    const item = probe.groups.find((entry) => entry.groupId === groupId);
    if (!item || !Number.isInteger(item.latestSeq) || item.latestSeq <= 0) {
      throw new Error(`无法探测群 ${groupId} 的最新消息序号（可能不在该群或服务端未返回水位）`);
    }
    return item.latestSeq;
  }

  async function latestPrivateSequence(userId: number, uid: string): Promise<number> {
    const probe = await ReadedReport.invoke(nt, sessionId, {
      c2c: [{ uid, lastReadTime: 0, lastReadSeq: 0 }],
    });
    const item = probe.c2c.find(
      (entry) => entry.uid === uid || String(entry.targetUin) === String(userId),
    );
    if (!item || !Number.isInteger(item.latestSeq) || item.latestSeq <= 0) {
      throw new Error(`无法探测私聊 ${userId} 的最新消息序号（服务端未返回水位）`);
    }
    return item.latestSeq;
  }

  async function walkGroupHistory(params: {
    groupId: number;
    anchorSequence?: number;
    count: number;
    reverseOrder: boolean;
  }): Promise<RawMessageBody[]> {
    const want = historyLimit(params.count);
    const collected = new Map<number, RawMessageBody>();
    const sequenceOf = (raw: RawMessageBody) => raw.contentHead?.sequence ?? 0;
    const anchor = params.anchorSequence ?? (await latestGroupSequence(params.groupId));

    if (params.reverseOrder) {
      let curEnd = anchor;
      for (let i = 0; i < HISTORY_MAX_REQUESTS && collected.size < want && curEnd >= 1; i++) {
        const start = Math.max(1, curEnd - HISTORY_CHUNK_SEQ + 1);
        const page = await historyGate(() =>
          fetchGroupHistoryRaw(nt, sessionId, {
            groupUin: params.groupId,
            startSeq: start,
            endSeq: curEnd,
          }),
        );
        const batch = page.messages as RawMessageBody[];
        if (batch.length === 0) {
          curEnd = start - 1;
          continue;
        }
        let minSeq = curEnd;
        for (const raw of batch) {
          const sequence = sequenceOf(raw);
          if (!Number.isInteger(sequence) || sequence < start || sequence > curEnd) {
            throw new Error(`群历史响应序号 ${sequence} 超出请求区间 ${start}-${curEnd}`);
          }
          if (sequence < minSeq) minSeq = sequence;
          if (!isNullRoamRecord(raw)) collected.set(sequence, raw);
        }
        curEnd = minSeq - 1;
      }
      return [...collected.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-want)
        .map((entry) => entry[1]);
    }

    let curStart = anchor;
    for (
      let i = 0;
      i < HISTORY_MAX_REQUESTS && collected.size < want && curStart <= UINT32_MAX;
      i++
    ) {
      const end = Math.min(UINT32_MAX, curStart + HISTORY_CHUNK_SEQ - 1);
      const page = await historyGate(() =>
        fetchGroupHistoryRaw(nt, sessionId, {
          groupUin: params.groupId,
          startSeq: curStart,
          endSeq: end,
        }),
      );
      const batch = page.messages as RawMessageBody[];
      if (batch.length === 0) break;
      let maxSeq = curStart - 1;
      for (const raw of batch) {
        const sequence = sequenceOf(raw);
        if (!Number.isInteger(sequence) || sequence < curStart || sequence > end) {
          throw new Error(`群历史响应序号 ${sequence} 超出请求区间 ${curStart}-${end}`);
        }
        if (sequence > maxSeq) maxSeq = sequence;
        if (!isNullRoamRecord(raw)) collected.set(sequence, raw);
      }
      if (maxSeq < curStart) break;
      curStart = maxSeq + 1;
    }
    return [...collected.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, want)
      .map((entry) => entry[1]);
  }

  async function walkPrivateHistory(params: {
    userId: number;
    friendUid: string;
    anchorSequence?: number;
    count: number;
    reverseOrder: boolean;
  }): Promise<RawMessageBody[]> {
    const want = historyLimit(params.count);
    const collected = new Map<number, RawMessageBody>();
    // 私聊窗口按服务端 NT 序号，不是会话内序号（SnowLuma 同款）。
    const sequenceOf = (raw: RawMessageBody) => raw.contentHead?.ntMsgSeq ?? 0;
    const anchor =
      params.anchorSequence ?? (await latestPrivateSequence(params.userId, params.friendUid));

    if (params.reverseOrder) {
      let curEnd = anchor;
      for (let i = 0; i < HISTORY_MAX_REQUESTS && collected.size < want && curEnd >= 1; i++) {
        const start = Math.max(1, curEnd - HISTORY_CHUNK_SEQ + 1);
        const page = await historyGate(() =>
          fetchC2cHistoryRaw(nt, sessionId, {
            friendUid: params.friendUid,
            startSeq: start,
            endSeq: curEnd,
          }),
        );
        const batch = page.messages as RawMessageBody[];
        if (batch.length === 0) {
          curEnd = start - 1;
          continue;
        }
        let minSeq = curEnd;
        for (const raw of batch) {
          const sequence = sequenceOf(raw);
          if (!Number.isInteger(sequence) || sequence < start || sequence > curEnd) {
            throw new Error(`私聊历史响应序号 ${sequence} 超出请求区间 ${start}-${curEnd}`);
          }
          if (sequence < minSeq) minSeq = sequence;
          if (!isNullRoamRecord(raw)) collected.set(sequence, raw);
        }
        curEnd = minSeq - 1;
      }
      return [...collected.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-want)
        .map((entry) => entry[1]);
    }

    let curStart = anchor;
    for (
      let i = 0;
      i < HISTORY_MAX_REQUESTS && collected.size < want && curStart <= UINT32_MAX;
      i++
    ) {
      const end = Math.min(UINT32_MAX, curStart + HISTORY_CHUNK_SEQ - 1);
      const page = await historyGate(() =>
        fetchC2cHistoryRaw(nt, sessionId, {
          friendUid: params.friendUid,
          startSeq: curStart,
          endSeq: end,
        }),
      );
      const batch = page.messages as RawMessageBody[];
      if (batch.length === 0) break;
      let maxSeq = curStart - 1;
      for (const raw of batch) {
        const sequence = sequenceOf(raw);
        if (!Number.isInteger(sequence) || sequence < curStart || sequence > end) {
          throw new Error(`私聊历史响应序号 ${sequence} 超出请求区间 ${curStart}-${end}`);
        }
        if (sequence > maxSeq) maxSeq = sequence;
        if (!isNullRoamRecord(raw)) collected.set(sequence, raw);
      }
      if (maxSeq < curStart) break;
      curStart = maxSeq + 1;
    }
    return [...collected.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, want)
      .map((entry) => entry[1]);
  }

  // ─────────────────────── AI 声聊（0x929D / 0x929B） ───────────────────────
  //
  // 0x929B 合成成功时服务端已经把语音发到群里，回包只给媒体索引、不给消息序号。
  // `send` 从群历史里按文件名找回那条自发语音，不落任何本地索引。

  const AI_VOICE_POLL_LIMIT = 30;
  const AI_VOICE_RECEIPT_ATTEMPTS = 10;
  const AI_VOICE_RECEIPT_GAP_MS = 500;

  async function synthesizeAiVoice(params: {
    groupId: number;
    voiceId: string;
    text: string;
    chatType: number;
  }) {
    const session = Math.floor(Math.random() * 0xffffffff) >>> 0;
    for (let attempt = 0; attempt < AI_VOICE_POLL_LIMIT; attempt++) {
      const result = await SendAiVoice.invoke(nt, sessionId, {
        groupCode: params.groupId,
        voiceId: params.voiceId,
        text: params.text,
        chatType: params.chatType as 1 | 2,
        msgRandom: session,
      });
      if (!SendAiVoice.isOk(result)) {
        throw new Error(`AI 语音合成失败：retCode=${result.retCode}`);
      }
      const node = result.audio?.node;
      if (node) return node;
    }
    throw new Error(`AI 语音合成 ${AI_VOICE_POLL_LIMIT} 次轮询后仍未完成`);
  }

  function aiVoiceMediaNode(node: {
    fileInfo: {
      fileSize: number;
      fileHash: string;
      fileSha1: string;
      fileName: string;
      type: { type: number; picFormat: number; videoFormat: number; voiceFormat: number };
      time: number;
      original: number;
    };
    urlParam: string;
    field3: number;
    uploadTime: number;
    ttlSeconds: number;
    subType: number;
  }): MediaIndexNode {
    return {
      fileUuid: node.urlParam,
      fileSize: node.fileInfo.fileSize,
      fileHash: node.fileInfo.fileHash,
      fileSha1: node.fileInfo.fileSha1,
      fileName: node.fileInfo.fileName,
      time: node.fileInfo.time,
      original: node.fileInfo.original,
      type: node.fileInfo.type,
      storeId: node.field3,
      uploadTime: node.uploadTime,
      ttl: node.ttlSeconds,
      subType: node.subType,
    };
  }

  /** 主文件直链：0x93D4_1 取 fileId，再 0x12A9_200 换 URL。 */
  async function resolveFlashDownload(
    filesetId: string,
    fileIndex = 1,
  ): Promise<{ url: string; fileName: string; fileSize: number }> {
    const delays = [0, 1000, 2000, 4000, 4000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
      const metas = await GetFlashDownloadUrl.invoke(nt, sessionId, { filesetUuid: filesetId });
      const meta = metas.find((item) => item.fileIndex === fileIndex);
      if (!meta) continue;
      if (!meta.fileId) continue;
      const url = await GetFlashDownload.invoke(nt, sessionId, {
        filesetUuid: meta.filesetUuid || filesetId,
        fileUuid: meta.fileUuid,
        fileId: meta.fileId,
        fileName: meta.fileName,
      });
      if (!url) throw new Error('闪传主文件直链为空');
      return { url, fileName: meta.fileName, fileSize: meta.fileSize };
    }
    throw new Error(`闪传文件集 ${filesetId} 的第 ${fileIndex} 个文件没有可用直链`);
  }

  async function waitAiVoiceReceipt(groupId: number, fileName: string): Promise<HistoryMessage> {
    if (!fileName) throw new Error('服务端未返回 AI 语音文件名，无法核对发送回执');
    for (let attempt = 0; attempt < AI_VOICE_RECEIPT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, AI_VOICE_RECEIPT_GAP_MS));
      }
      const raws = await walkGroupHistory({ groupId, count: 30, reverseOrder: true });
      for (let i = raws.length - 1; i >= 0; i--) {
        const item = await toHistoryMessage(raws[i]!, true);
        if (!item || item.senderId !== selfId) continue;
        const matched = item.message.some(
          (segment) => segment.type === 'record' && String(segment.data.file) === fileName,
        );
        if (matched) return item;
      }
    }
    throw new Error(
      `AI 语音已发布，但 ${AI_VOICE_RECEIPT_ATTEMPTS} 次群历史轮询都没找到回执（file=${fileName}）`,
    );
  }

  async function toHistoryMessage(
    raw: RawMessageBody,
    isGroup: boolean,
  ): Promise<HistoryMessage | null> {
    const decoded = decodeMessageBody(raw);
    if (decoded.elements.length === 0 && (raw.body?.msgContent?.length ?? 0) === 0) return null;
    const message = (await elementsToSegments(decoded.elements as unknown as InboundElement[], {
      isGroup,
      selfId,
      ...segmentResolvers(),
    })) as unknown as Segment[];
    const sequence = isGroup ? decoded.head.sequence : (decoded.head.ntMsgSeq ?? 0);
    if (!Number.isInteger(sequence) || sequence <= 0) return null;
    return {
      sequence,
      wireId: String(decoded.head.msgId),
      time: decoded.head.timestamp,
      senderId: decoded.sender.uin,
      senderName: decoded.sender.name ?? '',
      message,
      ...(!isGroup && decoded.sender.uid && decoded.sender.uin !== selfId
        ? { peerUid: decoded.sender.uid }
        : {}),
    };
  }

  /** wire uint64 msg_id → 有符号 int32（OneBot `message_id` 的惯用截断）。 */
  function toSignedInt32(value: number): number {
    if (!Number.isSafeInteger(value)) return 0;
    return Number(BigInt(value) & 0xffffffffn) | 0;
  }

  async function forwardNodeFromRaw(raw: RawMessageBody): Promise<ForwardMessageNode> {
    const decoded = decodeMessageBody(raw);
    const isGroup = (raw.responseHead?.grp?.groupUin ?? 0) > 0;
    const message = (await elementsToSegments(decoded.elements as unknown as InboundElement[], {
      isGroup,
      selfId,
      ...segmentResolvers(),
    })) as unknown as Segment[];
    const groupId = raw.responseHead?.grp?.groupUin ?? 0;
    return {
      userId: decoded.sender.uin,
      nickname: decoded.sender.name ?? String(decoded.sender.uin),
      time: decoded.head.timestamp,
      messageId: toSignedInt32(decoded.head.msgId),
      sequence: decoded.head.sequence,
      ...(groupId > 0 ? { groupId } : {}),
      message,
    };
  }

  async function fetchForwardNodesRaw(resId: string): Promise<RawMessageBody[]> {
    if (!selfUid) throw new Error('拉取合并转发需要自己的 uid（登录票据里没有）');
    const fetched = await fetchForwardRaw(nt, sessionId, { selfUid, resId });
    const messages = fetched.messages as RawMessageBody[];
    if (messages.length === 0) {
      throw new Error(fetched.error ?? '合并转发内容为空');
    }
    return messages;
  }

  async function toProtocolForwardNode(node: ForwardNode): Promise<ProtocolForwardNode> {
    const nested = node.children !== undefined && node.children.length > 0;
    return {
      ...(node.userId !== undefined ? { userUin: node.userId } : {}),
      ...(node.nickname ? { nickname: node.nickname } : {}),
      ...(node.time !== undefined ? { time: node.time } : {}),
      elements: nested
        ? []
        : ((await toElements(node.message)) as unknown as ProtocolForwardNode['elements']),
      ...(nested
        ? { innerForward: await Promise.all(node.children!.map(toProtocolForwardNode)) }
        : {}),
    };
  }

  async function forwardPayload(
    target: { groupId?: number; userId?: number },
    nodes: ForwardNode[],
  ) {
    const userUid =
      target.userId !== undefined
        ? options.resolveUidUin?.uidByUin(String(target.userId))
        : undefined;
    if (target.userId !== undefined && !selfUid) {
      throw new Error('私聊合并转发需要自己的 uid（登录票据里没有）');
    }
    return {
      ...(target.groupId !== undefined ? { groupId: target.groupId } : { userUin: target.userId }),
      ...(userUid ? { userUid } : {}),
      selfUin,
      selfUid: selfUid ?? '',
      nodes: await Promise.all(nodes.map(toProtocolForwardNode)),
    };
  }

  async function uploadForwardCard(
    target: { groupId?: number; userId?: number },
    nodes: ForwardNode[],
    preview?: ForwardPreview,
  ): Promise<{ resId: string; card: SendElement }> {
    const result = await sendLongMessage(nt, sessionId, await forwardPayload(target, nodes));
    return {
      resId: result.resId,
      card: {
        kind: 'forward',
        resId: result.resId,
        forwardSource: preview?.source ?? result.card.forwardSource,
        forwardSummary: preview?.summary ?? result.card.forwardSummary,
        forwardPrompt: preview?.prompt ?? result.card.forwardPrompt,
        forwardNews: preview?.news ?? result.card.forwardNews,
        forwardTSum: result.card.forwardTSum,
      },
    };
  }

  async function sendGroupElements(groupId: number, elements: SendElement[]): Promise<SendResult> {
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
  }

  async function sendPrivateElements(userId: number, elements: SendElement[]): Promise<SendResult> {
    const uid = options.resolveUidUin?.uidByUin(String(userId));
    const receipt = await sendC2cMessage(nt, sessionId, userId, elements, {
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
  }

  /** 已读上报：先报 0 水位读回服务端的 read/latest 对，再只推进落后的会话。 */
  async function markRead(
    groupIds: number[],
    c2cTargets: Array<{ userId: number; uid: string }>,
  ): Promise<void> {
    const probe = await ReadedReport.invoke(nt, sessionId, {
      groups: groupIds.map((groupId) => ({ groupId, lastReadSeq: 0 })),
      c2c: c2cTargets.map((target) => ({
        uid: target.uid,
        lastReadTime: 0,
        lastReadSeq: 0,
      })),
    });

    const groups = groupIds.flatMap((groupId) => {
      const item = probe.groups.find((entry) => entry.groupId === groupId);
      if (!item) throw new Error(`已读探测没有返回群 ${groupId} 的水位`);
      if (item.latestSeq < item.readSeq) {
        throw new Error(`群 ${groupId} 的 latestSeq 小于 readSeq`);
      }
      return item.latestSeq > item.readSeq ? [{ groupId, lastReadSeq: item.latestSeq }] : [];
    });

    const c2c = c2cTargets.flatMap((target) => {
      const item = probe.c2c.find(
        (entry) => entry.uid === target.uid || String(entry.targetUin) === String(target.userId),
      );
      if (!item) throw new Error(`已读探测没有返回私聊 ${target.userId} 的水位`);
      if (item.latestSeq < item.readSeq) {
        throw new Error(`私聊 ${target.userId} 的 latestSeq 小于 readSeq`);
      }
      if (item.latestSeq <= item.readSeq) return [];
      if (item.lastMsgTime <= 0) {
        throw new Error(`私聊 ${target.userId} 缺少最后消息时间，无法上报已读`);
      }
      return [{ uid: target.uid, lastReadTime: item.lastMsgTime, lastReadSeq: item.latestSeq }];
    });

    if (groups.length === 0 && c2c.length === 0) return;
    const confirm = await ReadedReport.invoke(nt, sessionId, { groups, c2c });

    for (const requested of groups) {
      const item = confirm.groups.find((entry) => entry.groupId === requested.groupId);
      if (!item || item.readSeq < requested.lastReadSeq) {
        throw new Error(`群 ${requested.groupId} 已读水位没有推进到 ${requested.lastReadSeq}`);
      }
    }
    for (const requested of c2c) {
      const item = confirm.c2c.find((entry) => (entry.uid || '') === requested.uid);
      if (!item || item.readSeq < requested.lastReadSeq) {
        throw new Error(`私聊 ${requested.uid} 已读水位没有推进到 ${requested.lastReadSeq}`);
      }
    }
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
      return sendGroupElements(groupId, await toElements(message));
    },

    async sendPrivateMessage(
      userId: number,
      message: Segment[],
      tempGroupId?: number,
    ): Promise<SendResult> {
      const elements = await toElements(message);
      if (!tempGroupId) return sendPrivateElements(userId, elements);
      const uid = options.resolveUidUin?.uidByUin(String(userId));
      const receipt = await sendMessage(nt, sessionId, {
        groupTemp: { groupUin: tempGroupId, toUid: uid ?? '' },
        elements,
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
        ...(friend.uid ? { uid: friend.uid } : {}),
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

    async setGroupAddRequest(flag: string, approve: boolean, reason: string): Promise<void> {
      const parsed = parseGroupRequestFlag(flag);
      // 实时推送的 flag 只有群号 + 申请人 uid（`add:` / `invite:`），裸序号也一样；
      // 这两种都必须去 0x10C0 反查 `sequence` / `eventType` / `operateTransInfo`。
      // 只有 `slreq:` 规范形态可以少一次网络往返。
      const resolved =
        parsed.kind === 'canonical'
          ? await resolveLiveGroupRequest(parsed)
          : await resolveGroupRequestFromInbox(parsed);
      await SetGroupRequest.invoke(nt, sessionId, {
        groupId: resolved.groupId,
        sequence: resolved.sequence,
        // 0x10C0 的 field 2 **原样**回填给 0x10C8：Lagrange 的拉取分支把 1 解成
        // Join、22 解成 Invite，`SetGroupNotification` 又把同一个 `Type` 原样发回去；
        // SnowLuma 的拉取文件头也写着「Field 2 in a list entry and in its approval
        // uses the same wire value」。所以这里不要再过 `groupRequestOperationType`
        // —— 它做的是「wire 值 → 客户端通知类型」，对 1 会返回 2，把入群申请发成邀请。
        eventType: resolved.eventType,
        approve,
        reason,
        ...(resolved.filtered ? { filtered: true } : {}),
        ...(resolved.operateTransInfo ? { operateTransInfo: resolved.operateTransInfo } : {}),
      });
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

    async sendPoke(target: { groupId?: number; userId: number; targetId?: number }): Promise<void> {
      await SendPoke.invoke(nt, sessionId, {
        isGroup: target.groupId !== undefined,
        peerUin: target.groupId ?? target.userId,
        targetUin: target.targetId ?? target.userId,
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

    // ─────────────────────── 历史 / 合并转发 / 已读 ───────────────────────

    history: {
      getGroupHistory: async (params) => {
        const raws = await walkGroupHistory(params);
        const out: HistoryMessage[] = [];
        for (const raw of raws) {
          const item = await toHistoryMessage(raw, true);
          if (item) out.push(item);
        }
        return out;
      },
      getPrivateHistory: async (params) => {
        const friendUid = options.resolveUidUin?.uidByUin(String(params.userId));
        if (!friendUid) throw new Error(`私聊历史需要对方 uid（${params.userId} 未观测到）`);
        const raws = await walkPrivateHistory({ ...params, friendUid });
        const out: HistoryMessage[] = [];
        for (const raw of raws) {
          const item = await toHistoryMessage(raw, false);
          if (item) out.push(item);
        }
        return out;
      },
    },

    forward: {
      uploadForward: async ({ groupId, userId, nodes }) => {
        // 只上传、又没给目标时用私聊命名空间（`userUin=自己` 与 SnowLuma 一致）。
        const target =
          groupId !== undefined || userId !== undefined
            ? { ...(groupId !== undefined ? { groupId } : {}), ...(userId ? { userId } : {}) }
            : { userId: selfId };
        const { resId } = await uploadForwardCard(target, nodes);
        return { resId };
      },
      sendForward: async ({ groupId, userId, nodes, preview }) => {
        const target = {
          ...(groupId !== undefined ? { groupId } : {}),
          ...(userId !== undefined ? { userId } : {}),
        };
        const { card, resId } = await uploadForwardCard(target, nodes, preview);
        const send =
          groupId !== undefined
            ? await sendGroupElements(groupId, [card])
            : await sendPrivateElements(userId!, [card]);
        return { resId, send };
      },
      getForwardMessage: async (resId) => {
        const raws = await fetchForwardNodesRaw(resId);
        const out: ForwardMessageNode[] = [];
        for (const raw of raws) out.push(await forwardNodeFromRaw(raw));
        return out;
      },
      forwardSingleMessage: async ({ groupId, userId, message }) => {
        const elements: SendElement[] = [];
        for (const segment of message) {
          if (segment.type !== 'forward') {
            elements.push(...(await toElements([segment])));
            continue;
          }
          const data = segment.data;
          const resId = String(data.id ?? data.res_id ?? data.forward_id ?? '').trim();
          if (!resId) throw new Error('转发段缺少 id');
          // 长消息 resId 按来源会话命名，直接转给别的会话收端打不开，必须重传。
          const nodes: ForwardNode[] = [];
          for (const raw of await fetchForwardNodesRaw(resId)) {
            const node = await forwardNodeFromRaw(raw);
            nodes.push({
              userId: node.userId,
              nickname: node.nickname,
              message: node.message,
              time: node.time,
            });
          }
          const target = groupId !== undefined ? { groupId } : { userId: userId! };
          const { card } = await uploadForwardCard(target, nodes);
          elements.push(card);
        }
        if (elements.length === 0) throw new Error('没有可转发的内容');
        return groupId !== undefined
          ? sendGroupElements(groupId, elements)
          : sendPrivateElements(userId!, elements);
      },
    },

    readReport: {
      markGroupRead: (groupId) => markRead([groupId], []),
      markPrivateRead: async (userId) => {
        const uid = options.resolveUidUin?.uidByUin(String(userId));
        if (!uid) throw new Error(`标记私聊已读需要对方 uid（${userId} 未观测到）`);
        await markRead([], [{ userId, uid }]);
      },
    },

    // ─────────────────────── 群文件（P8.2） ───────────────────────

    groupFile: {
      async uploadGroupFile(params) {
        const result = await sendGroupFile(nt, sessionId, {
          groupId: params.groupId,
          filePath: params.filePath,
          ...(params.fileName ? { fileName: params.fileName } : {}),
          ...(params.folderId ? { folderId: params.folderId } : {}),
          selfUin,
          publish: params.publish,
        });
        return {
          fileId: result.fileId,
          fileName: result.fileName,
          fileSize: result.fileSize,
        };
      },
      async uploadPrivateFile(params) {
        if (!selfUid) throw new Error('私聊文件需要自己的 uid（登录票据里没有）');
        const targetUid = options.resolveUidUin?.uidByUin(String(params.userId));
        if (!targetUid) throw new Error(`私聊文件需要对方 uid（${params.userId} 未观测到）`);
        const result = await sendPrivateFile(nt, sessionId, {
          userUid: targetUid,
          selfUid,
          selfUin,
          filePath: params.filePath,
          ...(params.fileName ? { fileName: params.fileName } : {}),
          send: params.send,
        });
        return { fileId: result.fileId };
      },
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
      transGroupFile: async (groupId, fileId) => {
        await TransGroupFile.invoke(nt, sessionId, { groupId, fileId });
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
      getPrivateFileUrl: async (_userId, fileId, fileHash) => {
        if (!selfUid) throw new Error('私聊文件下载链接需要自己的 uid（登录票据里没有）');
        return GetPrivateFileUrl.invoke(nt, sessionId, { selfUid, fileId, fileHash });
      },
    },

    // ─────────────────────── 收藏表情 ───────────────────────

    customFace: {
      async addCustomFace(source) {
        const bytes =
          typeof source === 'string'
            ? new Uint8Array(await readFile(cleanNtLocalPath(source)))
            : source;
        return AddCustomFace.invoke(nt, sessionId, { selfUin, imageBytes: bytes });
      },
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
      resolveCustomFaceUrl: async (identifier) => {
        const wanted = identifier.trim();
        if (!wanted) throw new Error('emoji_id 不能为空');
        const ids = await FetchCustomFaceList.invoke(nt, sessionId, { selfUin });
        const byMd5 = /^[0-9a-fA-F]{32}$/.test(wanted);
        const emojiId = ids.find((id) =>
          byMd5 ? parseCustomFaceId(id).md5.toLowerCase() === wanted.toLowerCase() : id === wanted,
        );
        if (!emojiId) throw new Error('收藏表情不在当前账号的收藏列表里');
        const { md5 } = parseCustomFaceId(emojiId);
        // SnowLuma 同款 URL 形态（`p.qpic.cn/qq_expression/<uin>/<emojiId>/0`）。
        return {
          emojiId,
          md5,
          url: `https://p.qpic.cn/qq_expression/${selfUin}/${emojiId}/0`,
        };
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
      clickInlineButton: (params) =>
        ClickInlineKeyboardButton.invoke(nt, sessionId, {
          groupId: params.groupId,
          botAppid: params.botAppid,
          msgSeq: params.msgSeq,
          buttonId: params.buttonId,
          callbackData: params.callbackData,
        }),
      translateEn2Zh: (words) => TranslateEnToZh.invoke(nt, sessionId, { words }),
    },

    groupAdminExtra: {
      async setGroupRemark(groupId: number, remark: string): Promise<void> {
        await SetGroupRemark.invoke(nt, sessionId, { groupId, remark });
      },
      async kickMembers(groupId, userIds, reject) {
        for (const userId of userIds) {
          const targetUid = options.resolveUidUin?.uidByUin(String(userId));
          if (!targetUid) throw new Error(`踢人需要对方 uid（${userId} 未观测到）`);
          await KickGroupMember.invoke(nt, sessionId, { groupId, targetUid, reject });
        }
      },
      async setAddOption(params) {
        await SetGroupAddOption.invoke(nt, sessionId, params);
      },
      listCategoryTags: (groupClass) => GetGroupCategoryTags.invoke(nt, sessionId, { groupClass }),
      async addCategoryTag(groupClass, name) {
        await AddGroupCategoryTag.invoke(nt, sessionId, { groupClass, name });
      },
      async removeCategoryTag(groupClass, name) {
        await DeleteGroupCategoryTag.invoke(nt, sessionId, { groupClass, name });
      },
      async getAdminPermissions(groupId, userId) {
        const snapshot = await GetAdminPermissions.invoke(nt, sessionId, { groupId, userId });
        return {
          recall_member_message: snapshot.recallMemberMessage,
          kick_member: snapshot.kickMember,
          kick_member_per_day: snapshot.kickMemberPerDay,
        };
      },
      async setAdminPermissions(params) {
        await SetAdminPermissions.invoke(nt, sessionId, params);
      },
      async setAdminReceiveVerify(groupId, userId, enable) {
        await SetAdminReceiveVerify.invoke(nt, sessionId, { groupId, userId, enable });
      },
      async setRobotAddOption(params) {
        await ModifyGroupExtInfo.invoke(nt, sessionId, {
          groupId: params.groupId,
          ...(params.robotMemberSwitch !== undefined
            ? { robotMemberSwitch: params.robotMemberSwitch }
            : {}),
          ...(params.robotMemberExamine !== undefined
            ? { robotMemberExamine: params.robotMemberExamine }
            : {}),
        });
      },
      async setGroupAvatar(groupId, source) {
        await setGroupAvatar(nt, sessionId, { groupId, uin: selfUin, source });
      },
      async getIgnoredGroupRequests() {
        const page = await FetchFilteredGroupRequests.invoke(nt, sessionId, { count: 50 });
        const person = (actor: { uid: string; uin: number; name: string }): number =>
          actor.uin || Number(options.resolveUidUin?.uinByUid(actor.uid) ?? 0);
        return page.requests
          .filter(
            (request) =>
              request.eventType === 1 || request.eventType === 2 || request.eventType === 22,
          )
          .map((request) => ({
            groupId: request.groupId,
            groupName: request.groupName,
            sequence: request.sequence,
            targetUin: person(request.target),
            targetName: request.target.name,
            invitorUin: person(request.invitor),
            invitorName: request.invitor.name,
            operatorUin: person(request.operator),
            operatorName: request.operator.name,
            comment: request.comment,
            checked: request.state !== 1,
            flag: [
              'slreq',
              '1',
              request.sequence,
              request.groupId,
              request.eventType,
              request.filtered ? 1 : 0,
            ].join(':'),
          }));
      },
      async getGroupSystemMessages(query = {}) {
        const count = query.count ?? 50;
        const [main, filtered] = await Promise.all([
          FetchGroupRequests.invoke(nt, sessionId, { count }),
          FetchFilteredGroupRequests.invoke(nt, sessionId, { count }),
        ]);
        const unique = new Map<string, (typeof main.requests)[number]>();
        for (const request of [...main.requests, ...filtered.requests]) {
          if (request.eventType !== 1 && request.eventType !== 2 && request.eventType !== 22) {
            continue;
          }
          const flag = [
            'slreq',
            '1',
            request.sequence,
            request.groupId,
            request.eventType,
            request.filtered ? 1 : 0,
          ].join(':');
          if (!unique.has(flag)) unique.set(flag, request);
        }
        const person = (actor: { uid: string; uin: number; name: string }) => {
          const uin = actor.uin || Number(options.resolveUidUin?.uinByUid(actor.uid) ?? 0);
          return {
            uin,
            name: actor.name,
            status: uin > 0 ? ('known' as const) : ('unknown' as const),
          };
        };
        return [...unique.entries()]
          .map(([flag, request]) => ({ flag, request }))
          .filter(({ request }) => {
            if (query.groupId !== undefined && request.groupId !== query.groupId) return false;
            if (query.onlyPending && request.state !== 1) return false;
            return true;
          })
          .map(({ flag, request }) => {
            const target = person(request.target);
            const invitor = person(request.invitor);
            const operator = person(request.operator);
            const requester = request.eventType === 2 ? invitor : target;
            return {
              group_id: request.groupId,
              group_name: request.groupName,
              request_id: request.sequence,
              requester_uin: requester.uin,
              requester_nick: requester.name,
              target_uin: target.uin,
              target_nick: target.name,
              target_status: target.status,
              invitor_uin: invitor.uin,
              invitor_nick: invitor.name,
              invitor_status: invitor.status,
              operator_uin: operator.uin,
              operator_nick: operator.name,
              operator_status: operator.status,
              message: request.comment,
              checked: request.state !== 1,
              flag,
            };
          });
      },
      async setGroupSearch(params) {
        await SetGroupSearch.invoke(nt, sessionId, params);
      },
      async setMemberInvitePolicy(groupId, policy) {
        const detail = await FetchGroupDetail.invoke(nt, sessionId, { groupId });
        await SetGroupInvitePolicy.invoke(nt, sessionId, {
          groupId,
          currentPrivilegeFlag: detail.privilegeFlag,
          policy,
        });
      },
      async setNewMemberHistoryVisibility(groupId, visible) {
        await SetGroupHistoryVisibility.invoke(nt, sessionId, { groupId, visible });
      },
      async setMemberPermissions(groupId, patch) {
        const changes: Array<['upload_album' | 'temporary_session' | 'create_group', boolean]> = [];
        if (patch.allowMemberUploadAlbum !== undefined) {
          changes.push(['upload_album', patch.allowMemberUploadAlbum]);
        }
        if (patch.allowMemberTemporarySession !== undefined) {
          changes.push(['temporary_session', patch.allowMemberTemporarySession]);
        }
        if (patch.allowMemberCreateGroup !== undefined) {
          changes.push(['create_group', patch.allowMemberCreateGroup]);
        }
        for (const [permission, allow] of changes) {
          const detail = await FetchGroupDetail.invoke(nt, sessionId, { groupId });
          await SetGroupMemberPermission.invoke(nt, sessionId, {
            groupId,
            currentPrivilegeFlag: detail.privilegeFlag,
            permission,
            allow,
          });
        }
      },
      async getGroupAdminSettings(groupId) {
        const [detail, robot] = await Promise.all([
          FetchGroupDetail.invoke(nt, sessionId, { groupId }),
          FetchGroupExtInfo.invoke(nt, sessionId, { groupId }),
        ]);
        const permissions = decodeGroupMemberPermissions(detail.privilegeFlag);
        return {
          add_type: detail.addType,
          group_question: detail.question,
          group_answer: detail.answer,
          robot_member_switch: robot.robotMemberSwitch,
          robot_member_examine: robot.robotMemberExamine,
          member_invite_policy: decodeMemberInvitePolicy(detail.privilegeFlag),
          allow_member_upload_album: permissions.allowMemberUploadAlbum,
          allow_member_temporary_session: permissions.allowMemberTemporarySession,
          allow_member_create_group: permissions.allowMemberCreateGroup,
          new_member_history_visible: decodeGroupHistoryVisibility(detail.groupFlagExt4),
          no_finger_open: detail.noFingerOpen,
          no_code_finger_open: detail.noCodeFingerOpen,
        };
      },
      async getGroupInfoEx(groupId: number) {
        const groups = await FetchGroupList.invoke(nt, sessionId);
        const group = groups.find((entry) => entry.groupId === groupId);
        if (!group) throw new Error(`没有该群的资料：${groupId}`);
        return {
          groupId: group.groupId,
          groupName: group.groupName,
          memberCount: group.memberCount,
          maxMemberCount: group.memberMax,
          groupRemark: group.remark,
          createTime: group.createdAt,
          // 0xFE5_2 不回群等级；不要拿成员等级冒充。
          level: 0,
          memo: group.announcement,
          description: group.description,
          allShut: group.shutUpAllTimestamp !== 0,
        };
      },
    },

    profile: {
      getQqShowUrl: (userId?: number) =>
        GetQqShowUrl.invoke(nt, sessionId, { uin: userId ?? selfId }),
      async setProfile(patch): Promise<void> {
        await SetSelfProfile.invoke(nt, sessionId, {
          uin: selfUin,
          ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
          ...(patch.personalNote !== undefined ? { signature: patch.personalNote } : {}),
          ...(patch.sex !== undefined ? { gender: patch.sex } : {}),
        });
      },
      async setAvatar(source): Promise<void> {
        await setSelfAvatar(nt, sessionId, { uin: selfUin, source });
      },
      async setSelfLongNick(longNick) {
        await SetSelfLongNick.invoke(nt, sessionId, { selfUin, longNick });
      },
      async setInputStatus(userId, eventType) {
        const targetUid = options.resolveUidUin?.uidByUin(String(userId));
        if (!targetUid) throw new Error(`设置输入状态需要对方 uid（${userId} 未观测到）`);
        await SetInputStatus.invoke(nt, sessionId, { targetUid, eventType });
      },
      async getProfileLike(params) {
        const self = !params.userId || params.userId === selfId;
        const targetUid = self ? selfUid : options.resolveUidUin?.uidByUin(String(params.userId));
        if (!targetUid) throw new Error(`查资料点赞需要对方 uid（${params.userId} 未观测到）`);
        const info = await GetProfileLike.invoke(nt, sessionId, {
          targetUid,
          start: params.start,
          limit: params.count,
          ...(self ? { self: true } : {}),
        });
        return {
          uid: info.uid,
          time: info.time,
          favorite: {
            totalCount: info.favoriteInfo.totalCount,
            lastTime: info.favoriteInfo.lastTime,
            todayCount: info.favoriteInfo.todayCount,
            users: info.favoriteInfo.users.map(mapLikeUser),
          },
          vote: {
            totalCount: info.voteInfo.totalCount,
            newCount: info.voteInfo.newCount,
            newNearbyCount: info.voteInfo.newNearbyCount,
            lastVisitTime: info.voteInfo.lastVisitTime,
            users: info.voteInfo.users.map(mapLikeUser),
          },
        };
      },
      async setOnlineStatus(params): Promise<void> {
        await SetOnlineStatus.invoke(nt, sessionId, {
          status: params.status,
          extStatus: params.extStatus,
          batteryStatus: params.batteryStatus,
        });
      },
      async setDiyOnlineStatus(params): Promise<void> {
        await SetDiyOnlineStatus.invoke(nt, sessionId, {
          faceId: params.faceId,
          text: params.wording,
          faceType: params.faceType,
        });
      },
    },

    contactsExtra: {
      async getFriendCategories(_withProfile: boolean) {
        // 好友列表这一条请求本身就带了公开资料 key；不再逐人补查，避免 N 次往返。
        const { friends, categories } = await fetchAllFriends(nt, sessionId);
        return categories.map((category) => ({
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          memberCount: category.memberCount,
          friends: friends
            .filter((entry) => entry.categoryId === category.categoryId)
            .map(({ friend }) => mapCategoryFriend(friend)),
        }));
      },
      async setFriendCategory(params): Promise<void> {
        const { friends, categories } = await fetchAllFriends(nt, sessionId);
        let categoryId = params.categoryId;
        if (categoryId === undefined) {
          const matches = categories.filter(
            (category) => category.categoryName === params.categoryName,
          );
          if (matches.length !== 1) {
            throw new Error(
              matches.length === 0
                ? `没有名为「${params.categoryName}」的好友分组`
                : `好友分组「${params.categoryName}」不唯一`,
            );
          }
          categoryId = matches[0]!.categoryId;
        }
        const friend = friends.find((entry) => entry.friend.uin === params.userId);
        const uid = friend?.friend.uid ?? options.resolveUidUin?.uidByUin(String(params.userId));
        if (!uid) throw new Error(`移动好友分组需要对方 uid（${params.userId} 未观测到）`);
        await SetFriendCategory.invoke(nt, sessionId, { uid, categoryId });
      },
      getRecommendArk: (params) =>
        params.kind === 'qq'
          ? GetBuddyRecommendArk.invoke(nt, sessionId, {
              uin: params.contactId,
              ...(params.phoneNumber !== undefined ? { phoneNumber: params.phoneNumber } : {}),
            })
          : GetGroupRecommendArk.invoke(nt, sessionId, { groupId: params.contactId }),
      getGroupShareLink: (params) =>
        GetGroupShareLink.invoke(nt, sessionId, {
          groupId: params.groupId,
          needShortUrl: params.needShortUrl,
          additionalParam: params.additionalParam,
        }),
      async sendTuwenArk(params) {
        const result = await SendTuwenArk.invoke(nt, sessionId, params);
        // 外层 OIDB errorCode=0 也可能下发失败，必须看 result.errorCode。
        if (result.errorCode !== 0) {
          throw new Error(
            `图文 Ark 发送失败：code=${result.errorCode} ${result.errorMessage}`.trim(),
          );
        }
        return result;
      },
    },

    flashTransfer: {
      async createTask(files, name, thumbPath) {
        if (!selfUid) throw new Error('创建闪传任务需要自己的 uid（登录票据里没有）');
        const result = await uploadFlashFiles(
          nt,
          sessionId,
          files.map((file) => ({
            path: file.path,
            ...(file.name !== undefined ? { name: file.name } : {}),
          })),
          {
            ...(name !== undefined ? { name } : {}),
            ...(thumbPath !== undefined ? { thumbPath } : {}),
            uploader: { uin: selfUin, nickname: nickname || selfUin, uid: selfUid },
          },
        );
        return { filesetId: result.filesetUuid, shareUrl: result.shareUrl };
      },
      async getFilesetInfo(filesetId) {
        const entries = await GetFilesetDetail.invoke(nt, sessionId, { filesetUuid: filesetId });
        return entries.map((entry) => ({
          filesetId: entry.filesetUuid,
          fileName: entry.fileName,
          origName: entry.origName,
          fileSize: entry.fileSize,
          shareUrl: entry.shareUrl,
          fileId: entry.fileId,
          downloadUrl: entry.downloadUrl,
        }));
      },
      async listFilesets() {
        const entries = await ListFilesets.invoke(nt, sessionId, {});
        return entries.map((entry) => ({
          filesetId: entry.filesetUuid,
          fileName: entry.fileName,
          origName: entry.origName,
          fileSize: entry.fileSize,
          shareUrl: entry.uploadUrl,
          fileId: entry.fileId,
          downloadUrl: '',
        }));
      },
      async getShareLink(filesetId) {
        const entries = await GetFilesetDetail.invoke(nt, sessionId, { filesetUuid: filesetId });
        return entries.find((entry) => entry.shareUrl)?.shareUrl ?? '';
      },
      async deleteFile(filesetId) {
        await DeleteFlashFile.invoke(nt, sessionId, { filesetUuid: filesetId });
      },
      async renameFile(filesetId, newName) {
        await RenameFlashFile.invoke(nt, sessionId, { filesetUuid: filesetId, newName });
      },
      async sendFlashMsg(filesetId, target) {
        if (target.groupId !== undefined) {
          await SendFlashMsg.invoke(nt, sessionId, {
            groupId: target.groupId,
            filesetUuid: filesetId,
          });
          return;
        }
        if (target.userId === undefined) {
          throw new Error('send_flash_msg: user_id 或 group_id 必须给一个');
        }
        const targetUid = options.resolveUidUin?.uidByUin(String(target.userId));
        if (!targetUid) {
          throw new Error(`发送闪传需要对方 uid（${target.userId} 未观测到）`);
        }
        await SendFlashMsg.invoke(nt, sessionId, { targetUid, filesetUuid: filesetId });
      },
      async getFileUrl(filesetId, fileIndex) {
        return (await resolveFlashDownload(filesetId, fileIndex)).url;
      },
      async downloadFileset(filesetId, fileIndex) {
        return resolveFlashDownload(filesetId, fileIndex);
      },
      async getFilesetIdByCode(shareCode) {
        const url = flashShareUrl(shareCode);
        const response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error('get_fileset_id: 分享页不允许重定向');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`get_fileset_id: 分享页 HTTP ${response.status}`);
        }
        const html = await readLimitedText(response, 2 * 1024 * 1024);
        const match =
          /fileset_id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
            html,
          );
        if (!match) throw new Error('get_fileset_id: 分享页里找不到 fileset_id');
        return match[1]!;
      },
    },

    aiVoice: {
      async listCharacters(groupId: number, chatType: number) {
        const list = await FetchAiVoiceList.invoke(nt, sessionId, { groupId, chatType });
        return list.map((category) => ({
          category: category.category,
          characters: category.voices.map((voice) => ({
            characterId: voice.voiceId,
            characterName: voice.voiceDisplayName,
            previewUrl: voice.voiceExampleUrl,
          })),
        }));
      },
      async generate(groupId: number, character: string, text: string, chatType: number) {
        const raw = await synthesizeAiVoice({
          groupId,
          voiceId: character,
          text,
          chatType,
        });
        return GetGroupPttUrl.invoke(nt, sessionId, {
          groupId,
          node: aiVoiceMediaNode(raw),
        });
      },
      async send(groupId: number, character: string, text: string, chatType: number) {
        const raw = await synthesizeAiVoice({
          groupId,
          voiceId: character,
          text,
          chatType,
        });
        const receipt = await waitAiVoiceReceipt(groupId, raw.fileInfo.fileName);
        return { sequence: receipt.sequence, timestamp: receipt.time };
      },
    },

    // 收藏走微云 collector，需要 weiyun.com 的 p_skey。
    ...(options.webCredentials
      ? {
          collection: {
            list: (category?: number, count?: number) =>
              withRetry(options.webCredentials!, 'weiyun.com', (cred) =>
                getCollectionList({
                  uin: cred.uin,
                  pskey: cred.pskey,
                  category: category ?? 0,
                  count: count ?? 50,
                }),
              ),
          },
        }
      : {}),

    ...(options.shutdown
      ? {
          botControl: {
            shutdown: (reason: string) => options.shutdown!(reason),
          },
        }
      : {}),

    rkey: {
      async getDownloadRkeys() {
        const entries = await FetchDownloadRkeys.invoke(nt, sessionId, { types: [10, 20] });
        return entries.map((entry) => ({
          type: entry.type,
          rkey: entry.rkey,
          ttlSeconds: entry.ttlSeconds,
        }));
      },
    },

    // ─────────────────────── 自定义扩展：装扮 / 字体 / 位置共享 ───────────────────────
    dress: {
      getResources: async ({ kind, itemId }) => {
        if (kind === 'bubble') return getBubbleResources(nt, sessionId, itemId);
        if (kind === 'font') return getFontResource(nt, sessionId, itemId);
        return getPendantResources(nt, sessionId, itemId);
      },
    },

    font: {
      convert: async (params) => {
        const outputPath =
          params.output ??
          (params.input.toLowerCase().endsWith('.ftf')
            ? `${params.input.slice(0, -4)}.ttf`
            : `${params.input}.ttf`);
        const options = {
          ...(params.assetsDir !== undefined ? { assetsDir: params.assetsDir } : {}),
          ...(params.color !== undefined ? { color: params.color } : {}),
          ...(params.colorChars !== undefined ? { colorChars: params.colorChars } : {}),
          ...(params.checkOts !== undefined ? { checkOts: params.checkOts } : {}),
        };
        if (nt.convertFontAsync) {
          await nt.convertFontAsync(params.input, outputPath, options);
        } else if (nt.convertFont) {
          nt.convertFont(params.input, outputPath, options);
        } else {
          throw new NotImplementedError('ftf2ttf');
        }
        return {
          inputPath: params.input,
          outputPath,
          pipelineVersion: nt.getFontPipelineVersion?.() ?? 0,
        };
      },
    },

    location: {
      async start(params) {
        const isGroup = params.groupId !== undefined;
        const result = await StartLocationShare.invoke(nt, sessionId, {
          scene: isGroup ? 'group' : 'c2c',
          peer: (isGroup ? params.groupId : params.userId)!,
          ...(isGroup ? {} : { selfUin: selfId }),
          longitude: params.longitude,
          latitude: params.latitude,
          ...(params.interval !== undefined ? { interval: params.interval } : {}),
        });
        if (!result.ok) {
          throw new Error(`发起位置共享失败：code=${result.code} ${result.message}`);
        }
        const elements = buildShareLocationElements(isGroup ? 'group' : 'c2c');
        const send = isGroup
          ? await sendGroupElements(params.groupId!, elements)
          : await sendPrivateElements(params.userId!, elements);
        return { code: result.code, message: result.message, send };
      },
      async report(params) {
        const isGroup = params.groupId !== undefined;
        const result = await ReportLocation.invoke(nt, sessionId, {
          scene: isGroup ? 'group' : 'c2c',
          peer: (isGroup ? params.groupId : params.userId)!,
          ...(isGroup ? {} : { selfUin: selfId }),
          longitude: params.longitude,
          latitude: params.latitude,
          ...(params.extra !== undefined ? { extra: params.extra } : {}),
        });
        if (!result.ok) {
          throw new Error(`上报位置共享失败：code=${result.code} ${result.message}`);
        }
        return { code: result.code, message: result.message, interval: result.interval };
      },
    },

    misc: {
      getGroupGiftList: (groupId: number) =>
        GroupGiftPanel.invoke(nt, sessionId, { groupUin: groupId }),
      getMiniAppArk: (params) => GetMiniAppArk.invoke(nt, sessionId, params) as Promise<unknown>,
      async requestDecryptKey(dbPath: string): Promise<string> {
        const bytes = await readFile(dbPath);
        if (bytes.length < 0xaf) throw new Error('数据库文件过短，读不到 128 字符盐');
        const dbSalt = bytes.subarray(0x2f, 0xaf).toString('utf8');
        if (!/^[0-9a-fA-F]{128}$/.test(dbSalt)) {
          throw new Error('数据库盐不是 128 字符十六进制字符串');
        }
        return RequestDecryptKey.invoke(nt, sessionId, dbSalt);
      },
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
      async setEssence(params: {
        groupId: number;
        sequence: number;
        random: number;
        enable: boolean;
      }) {
        await SetGroupEssence.invoke(nt, sessionId, params);
      },
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
      // 礼物商城：查询与 WeQ 一样走 VIP 域（p_skey），下单只换一次票、不重放。
      getGiftMallHome: (toUin?: number) =>
        withRetry(source, VIP, (cred) =>
          fetchGiftMallHomePageExtraInfo(cred, toUin ?? Number(selfUin)),
        ),
      getGiftMallList: (params: {
        toUin?: number;
        tabName?: string;
        subTabName?: string[];
        attachInfo?: string;
        batchNum?: number;
        crowdTab?: string;
      }) =>
        withRetry(source, VIP, (cred) =>
          fetchGiftMallGiftList(cred, params.toUin ?? Number(selfUin), {
            ...(params.tabName ? { tabName: params.tabName as never } : {}),
            ...(params.subTabName ? { subTabName: params.subTabName as never } : {}),
            ...(params.attachInfo !== undefined ? { attachInfo: params.attachInfo } : {}),
            ...(params.batchNum !== undefined ? { batchNum: params.batchNum } : {}),
            ...(params.crowdTab !== undefined ? { crowdTab: params.crowdTab } : {}),
          }),
        ),
      searchGiftMall: (params: {
        keyword: string;
        toUin?: number;
        pageNo?: number;
        pageSize?: number;
        attachInfo?: string;
      }) =>
        withRetry(source, VIP, (cred) =>
          searchGiftMall(cred, {
            keyword: params.keyword,
            toUin: params.toUin ?? Number(selfUin),
            pageNo: params.pageNo ?? 1,
            pageSize: params.pageSize ?? 20,
            ...(params.attachInfo !== undefined ? { attachInfo: params.attachInfo } : {}),
          }),
        ),
      getGiftMallGift: (giftId: string, toUin?: number) =>
        withRetry(source, VIP, (cred) =>
          fetchGiftMallSingleGiftInfo(cred, giftId, toUin ?? Number(selfUin)),
        ),
      getGiftMallVip: (giftId: string) =>
        withRetry(source, VIP, (cred) => fetchGiftMallVipInfo(cred, giftId)),
      getGiftMallWall: (params: { isSend: boolean; beginTime: number; batchInfo: string }) =>
        withRetry(source, VIP, (cred) => fetchGiftMallWall(cred, params)),
      getGiftMallAiDiscStatus: () =>
        withRetry(source, VIP, (cred) => fetchGiftMallAIDiscStatus(cred)),
      async sendGift(params: {
        gift: { giftId: number; giftPrice?: number; svipDiscount?: number };
        toUin: number;
        message?: string;
        needAnonymous?: boolean;
        buyNum?: number;
      }) {
        if (params.gift.giftPrice === undefined || params.gift.svipDiscount === undefined) {
          throw new Error('礼物缺少 giftPrice / svipDiscount，请先读取列表或详情');
        }
        const request = buildGiftMallSendRequest({
          gift: {
            giftId: params.gift.giftId,
            giftPrice: params.gift.giftPrice,
            svipDiscount: params.gift.svipDiscount,
          },
          senderUin: Number(selfUin),
          toUin: params.toUin,
          ...(params.message !== undefined ? { message: params.message } : {}),
          ...(params.needAnonymous !== undefined ? { needAnonymous: params.needAnonymous } : {}),
          ...(params.buyNum !== undefined ? { buyNum: params.buyNum } : {}),
        });
        const cred = await source.forDomain(VIP);
        return submitGiftMallBuyItem(cred, request);
      },
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
    async getMsgDetail(uin: number | undefined, tid: string, pos: number, num: number) {
      return withRetry(source, domain, (cred) =>
        getQzoneMsgDetail(cred, target(uin), tid, pos, num),
      );
    },
    getHomeFeeds: (uin?: number, cursor?: string) =>
      withRetry(source, domain, (cred) => getQzoneHomeFeeds(cred, target(uin), cursor)),
    getFeedDetail: (tid: string) =>
      withRetry(source, domain, (cred) => getQzoneFeedDetail(cred, tid)),
    getShareArk: (feed: Record<string, unknown>) =>
      withRetry(source, domain, (cred) => getQzoneShareArk(cred, feed as never)),
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
    async forwardMsg(uin: number | undefined, tid: string, reason: string) {
      const cred = await source.forDomain(domain);
      await forwardQzoneMsg(cred, target(uin), tid, reason);
    },
  };
}

const QFILE_SHARE_ORIGIN = 'https://qfile.qq.com';

/** 分享码 / 官方分享链接 → 受控的 qfile 分享页 URL。 */
function flashShareUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('get_fileset_id: 分享码不能为空');
  let code = value;

  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (cause) {
      throw new Error('get_fileset_id: 需要 qfile.qq.com 官方分享链接', { cause });
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'qfile.qq.com' ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      throw new Error('get_fileset_id: 需要 qfile.qq.com 官方分享链接');
    }
    const match = /^\/q\/([^/]+)\/?$/.exec(parsed.pathname);
    if (!match) throw new Error('get_fileset_id: 需要 qfile.qq.com 官方分享链接');
    try {
      code = decodeURIComponent(match[1]!);
    } catch (cause) {
      throw new Error('get_fileset_id: 需要 qfile.qq.com 官方分享链接', { cause });
    }
  }

  const forbidden = Array.from(code).some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point <= 0x20 || point === 0x7f || '/\\?#'.includes(char);
  });
  if (code.length > 256 || forbidden) throw new Error('get_fileset_id: 分享码非法');
  return `${QFILE_SHARE_ORIGIN}/q/${encodeURIComponent(code)}`;
}

async function readLimitedText(
  response: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<string> {
  if (!response.body) throw new Error('get_fileset_id: 分享页响应没有 body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('get_fileset_id: 分享页过大');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function mapLikeUser(user: LikeUserInfo): ProfileLikeUserInfo {
  return {
    uid: user.uid,
    uin: 0,
    src: user.src,
    latestTime: user.latestTime,
    count: user.count,
    giftCount: user.giftCount,
    customId: user.customId,
    lastCharged: user.lastCharged,
    availableCount: user.availableCount,
    todayVotedCount: user.todayVotedCount,
    nick: user.nick,
    gender: user.gender,
    age: user.age,
    isFriend: user.isFriend,
    isVip: user.isVip,
    isSvip: user.isSvip,
  };
}

function mapCategoryFriend(friend: {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
  categoryId: number;
  profile?: PublicProfileFields;
}): FriendInfo {
  return {
    userId: friend.uin,
    nickname: friend.nickname,
    remark: friend.remark,
    categoryId: friend.categoryId,
    ...(friend.profile ? { profile: friend.profile } : {}),
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
    shutUpTime: member.shutUpTime,
  };
}
