/**
 * OneBot action 的业务后端。
 *
 * SnowLuma 的 action 直接调 `bridge.apis.<area>.<method>()`（183 个方法），
 * 那是它 core 层的形状。WeqBot 没有这一层，但也不需要照搬：**OneBot 层只声明
 * 它真正要的能力**，由 `@weqbot/bot` 用 `ProtocolClient` 实现，测试里可以换成
 * 桩。这样 onebot 包不依赖 native、不依赖会话生命周期，也能被单测。
 *
 * 约定：
 *   - 能做的返回结果；做不到的抛 {@link NotImplementedError}，适配层翻成
 *     `retcode 1404`（OneBot 的「不支持」），**不要**返回假数据；
 *   - 入参已是 OneBot 语义（QQ 号、群号、segment），后端负责换成协议调用。
 */

/** 后端没有实现这个能力。适配层把它翻成 `retcode 1404`。 */
export class NotImplementedError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(`action 尚未实现：${action}`);
    this.name = 'NotImplementedError';
    this.action = action;
  }
}

/** OneBot 的 `send_*` 结果。`messageId` 由适配层分配，后端只回 QQ 侧定位信息。 */
export interface SendResult {
  /** QQ 侧消息序号（群内 seq / 私聊会话 seq）。 */
  sequence: number;
  /** 私聊的 client sequence；群聊为 0。 */
  clientSequence?: number;
  /** wire 层 random。 */
  random?: number;
  /** unix 秒。 */
  timestamp?: number;
}

export interface LoginInfo {
  userId: number;
  nickname: string;
  /** 账号 uid（`u_...`）。 */
  uid?: string;
}

export interface FriendInfo {
  userId: number;
  nickname: string;
  remark: string;
}

export interface GroupInfo {
  groupId: number;
  groupName: string;
  memberCount: number;
  maxMemberCount: number;
}

export interface GroupMemberInfo {
  groupId: number;
  userId: number;
  nickname: string;
  card: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
  area: string;
  joinTime: number;
  lastSentTime: number;
  level: string;
  role: 'owner' | 'admin' | 'member';
  title: string;
}

export interface StrangerInfo {
  userId: number;
  nickname: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
}

/** OneBot segment（已按 `message` 参数解析好）。 */
export type { Segment } from './segments';

/**
 * 撤回所需的服务端定位信息。
 *
 * 不同场景要的字段不同：群聊只要 `sequence`，私聊要 `clientSequence` +
 * `messageSequence` + `random` + `timestamp`。由适配层的 `MessageIdMap` 提供。
 */
export interface RecallTarget {
  isGroup: boolean;
  targetId: number;
  sequence: number;
  clientSequence?: number;
  random?: number;
  timestamp?: number;
}

// ─────────────────────── 按域分组的能力面（P8，2026-11-14） ───────────────────────
//
// 现状的 26 个扁平方法是历史包袱；SnowLuma 的 226 条 action 如果继续平铺会把
// 接口变成不可维护的清单。新增能力一律按域分组（可选字段），action 用
// `available(backend)` 判定（见 `actions/index.ts`）。

export interface GroupFileItemInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
  uploadedTime: number;
  expireTime: number;
  modifiedTime: number;
  downloadedTimes: number;
  uploaderUin: number;
  uploaderName: string;
  parentDirectory: string;
}

export interface GroupFolderItemInfo {
  folderId: string;
  parentDirectoryId: string;
  folderName: string;
  createTime: number;
  modifiedTime: number;
  creatorUin: number;
  creatorName: string;
  totalFileCount: number;
}

export interface GroupFilePageResult {
  files: GroupFileItemInfo[];
  folders: GroupFolderItemInfo[];
  isEnd: boolean;
}

/** 群文件（`group-file.ts`）。 */
export interface GroupFileBackend {
  listGroupFiles(
    groupId: number,
    directory: string,
    startIndex: number,
    pageSize: number,
  ): Promise<GroupFilePageResult>;
  getGroupFileUrl(groupId: number, fileId: string, busId: number): Promise<string>;
  getGroupFileCount(
    groupId: number,
  ): Promise<{ fileCount: number; maxCount: number; isFull: boolean }>;
  getGroupFileSpace(groupId: number): Promise<{ usedSpace: number; totalSpace: number }>;
  deleteGroupFile(groupId: number, fileId: string): Promise<void>;
  renameGroupFile(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    newFileName: string,
  ): Promise<void>;
  moveGroupFile(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    targetDirectory: string,
  ): Promise<void>;
  createGroupFolder(groupId: number, folderName: string): Promise<string>;
  deleteGroupFolder(groupId: number, folderId: string): Promise<void>;
  renameGroupFolder(groupId: number, folderId: string, newName: string): Promise<void>;
}

export interface CustomFaceEntry {
  emojiId: string;
  desc?: string;
}

/** 收藏表情（`extended.ts` 的 `fetch_custom_face` 家族）。 */
export interface CustomFaceBackend {
  listCustomFaces(): Promise<string[]>;
  getCustomFaceDetail(emojiIds: string[]): Promise<CustomFaceEntry[]>;
  modifyCustomFace(emojiId: string, desc: string): Promise<void>;
  moveCustomFaceToFront(emojiId: string): Promise<void>;
  deleteCustomFace(emojiIds: string[]): Promise<void>;
}

export interface GroupTodoEntry {
  sourceId: string;
  sequence: string;
  random: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  completed: boolean;
}

/** 群待办（`0xF90` / `0x9474_0`）。 */
export interface GroupTodoBackend {
  setGroupTodo(groupId: number, msgSeq: number): Promise<void>;
  completeGroupTodo(groupId: number, msgSeq: number): Promise<void>;
  cancelGroupTodo(groupId: number, msgSeq: number): Promise<void>;
  getGroupTodoList(groupId: number): Promise<GroupTodoEntry[]>;
}

/** 历史消息（只读）。 */
export interface MessageHistoryBackend {
  getGroupHistory(
    groupId: number,
    startSeq: number,
    endSeq: number,
  ): Promise<Record<string, unknown>[]>;
  getPrivateHistory(
    userId: number,
    startSeq: number,
    endSeq: number,
  ): Promise<Record<string, unknown>[]>;
}

/** 合并转发（只读）。 */
export interface ForwardBackend {
  getForwardMessage(resId: string): Promise<Record<string, unknown>[]>;
}

/** 好友关系写操作 / 单向好友 / 可疑申请。 */
export interface FriendExtraBackend {
  deleteFriend(userId: number): Promise<void>;
  setFriendRemark(userId: number, remark: string): Promise<void>;
  getUnidirectionalFriends(): Promise<unknown[]>;
  getDoubtFriendRequests(count: number): Promise<unknown[]>;
  setDoubtFriendRequest(flag: string, approve: boolean): Promise<void>;
}

/** 群公告（web cgi，需要管理权限）。 */
export interface GroupNoticeBackend {
  /** SnowLuma 形状：notice_id / sender_id / publish_time / message / settings / read_num / ... */
  getGroupNotice(groupId: number): Promise<unknown[]>;
  sendGroupNotice(params: {
    groupId: number;
    content: string;
    /** base64（可带 data: 前缀）或 http(s) URL。 */
    image?: string;
    pinned?: number;
    type?: number;
    sendToNewMembers?: boolean;
    isShowEditCard?: number;
    tipWindowType?: number;
    confirmRequired?: number;
  }): Promise<void>;
  deleteGroupNotice(groupId: number, fid: string): Promise<void>;
}

/** 群相册（web cgi + OIDB/trpc）。 */
export interface GroupAlbumBackend {
  listAlbums(groupId: number): Promise<unknown[]>;
  uploadImage(params: {
    groupId: number;
    albumId: string;
    albumName: string;
    image: Uint8Array;
    fileName?: string;
  }): Promise<{ session: string }>;
  /** `video` 可以是本地路径或字节；封面/宽高/时长必须由调用方给（服务端不做探测）。 */
  uploadVideo(params: {
    groupId: number;
    albumId: string;
    albumName: string;
    video: Uint8Array | string;
    cover: Uint8Array;
    durationMs: number;
    width: number;
    height: number;
    fileName: string;
  }): Promise<unknown>;
  listMedia(
    groupId: number,
    albumId: string,
    attachInfo: string,
  ): Promise<{ mediaList: unknown[]; nextAttachInfo: string }>;
  comment(params: {
    groupId: number;
    albumId: string;
    lloc: string;
    content: string;
    batchId?: string;
  }): Promise<unknown>;
  setLike(params: {
    groupId: number;
    albumId: string;
    batchId: string;
    lloc?: string;
    like: boolean;
  }): Promise<{ id: string | null; status: number | null }>;
  deleteMedia(params: {
    groupId: number;
    albumId: string;
    lloc: string;
    batchId?: string;
  }): Promise<void>;
}

/** 群荣誉（web 页面解析）。 */
export interface GroupHonorBackend {
  getGroupHonor(
    groupId: number,
    type: 'all' | 'talkative' | 'performer' | 'legend' | 'emotion',
  ): Promise<{
    current_talkative: unknown | null;
    talkative_list: unknown[];
    performer_list: unknown[];
    legend_list: unknown[];
    emotion_list: unknown[];
  }>;
}

/** 群打卡（web trpc）。 */
export interface GroupSigninBackend {
  getSignedList(params: {
    groupId: number;
    dayYmd?: string;
    offset?: number;
    limit?: number;
  }): Promise<unknown[]>;
}

/** 群精华（web cgi）。 */
export interface GroupEssenceBackend {
  getEssence(
    groupId: number,
    pageStart: number,
    pageLimit: number,
  ): Promise<{ messages: unknown[]; complete: boolean }>;
}

/** 账号侧 web 能力（装扮 / 会员 / 特别关心 / 好友互动标记）。 */
export interface AccountWebBackend {
  getSelfDress(): Promise<unknown>;
  getVipInfo(): Promise<unknown>;
  getSpecialCare(): Promise<unknown>;
  getFriendDress(targetUin: number): Promise<unknown>;
  getFriendMutualMark(targetUin: number): Promise<unknown>;
  getDressRank(appId: number, pageIndex?: number, pageSize?: number): Promise<unknown[]>;
  searchDress(
    appId: number,
    keyword: string,
    pageIndex?: number,
    pageSize?: number,
  ): Promise<{ items: unknown[]; total: number }>;
}

/** 群策略 / @全体剩余次数（标签需要 groupClass，等真机核对后再加）。 */
export interface GroupPolicyBackend {
  getGroupMessagePolicies(): Promise<unknown[]>;
  getGroupAtAllRemain(groupId: number): Promise<{
    canAtAll: boolean;
    remainCountForGroup: number;
    remainCountForUin: number;
  }>;
}

/** 表情回应 / 按钮回调 / 群签到 / 系统表情 / 翻译。 */
export interface InteractionExtraBackend {
  getEmojiLikes(params: {
    groupId: number;
    sequence: number;
    emojiId: string;
    emojiType?: number;
    count?: number;
    cookie?: string;
  }): Promise<{
    users: Array<{ uin: number; nick: string; headUrl: string }>;
    cookie: string;
    isLast: boolean;
  }>;
  setReaction(params: {
    groupId: number;
    sequence: number;
    code: string;
    isSet: boolean;
  }): Promise<void>;
  sendGroupSign(groupId: number): Promise<void>;
  listSystemFaces(): Promise<SystemFaceInfo[]>;
  getSystemFace(faceId: number): Promise<SystemFaceInfo | null>;
  translateEn2Zh(words: string[]): Promise<string[]>;
}

/** 系统表情目录里的一项（已从服务端分组拍平）。 */
export interface SystemFaceInfo {
  faceId: number;
  name: string;
  /** 大表情 / 魔法表情（服务端 `isSuperFace` 判定）。 */
  isSuper?: boolean;
  /** 原始 emojiId（如 `/表情名`），用于展示与发消息。 */
  emojiId?: string;
  describe?: string;
}

/** QQ 空间（web cgi，P8.4）。 */
export interface QzoneBackend {
  getProfile(targetUin?: number): Promise<{ name: string; description: string }>;
  setProfile(patch: { name?: string; description?: string }): Promise<void>;
  getMsgList(
    targetUin: number | undefined,
    pos: number,
    num: number,
  ): Promise<{ total: number; list: unknown[] }>;
  getFeeds(
    pageNum: number,
    count: number,
    cursor?: string,
  ): Promise<{ feeds: unknown[]; hasMore: boolean; nextCursor?: string }>;
  setLike(targetUin: number | undefined, tid: string, like: boolean): Promise<void>;
  comment(targetUin: number | undefined, tid: string, content: string): Promise<unknown>;
  reply(
    targetUin: number | undefined,
    tid: string,
    target: { commentId: string; commentUin: string; replyTo?: { uin: string; name: string } },
    content: string,
  ): Promise<unknown>;
  setMsgRight(
    targetUin: number | undefined,
    tid: string,
    ugcRight: number,
    targetUins?: string[],
  ): Promise<{ ugc_right: number }>;
  setBan(userId: number, enable: boolean): Promise<void>;
  publish(
    content: string,
    images: string[],
    ugcRight?: number,
    targetUins?: string[],
  ): Promise<{ tid?: string; time?: number }>;
  deleteMsg(targetUin: number | undefined, tid: string): Promise<void>;
  getPublicCapabilities(): Promise<unknown>;
  getPublicFeeds(cursor?: string): Promise<unknown>;
  getPublicFeedDetail(feed: Record<string, unknown>): Promise<unknown>;
  getPublicComments(feed: Record<string, unknown>, cursor: string): Promise<unknown>;
  getPublicReplies(
    feed: Record<string, unknown>,
    comment: Record<string, unknown>,
    cursor?: string,
    pageSize?: number,
  ): Promise<unknown>;
  setPublicUpvote(feed: Record<string, unknown>, enable: boolean): Promise<unknown>;
  setPublicLike(feed: Record<string, unknown>, enable: boolean): Promise<unknown>;
  setPublicCommentLike(
    feed: Record<string, unknown>,
    comment: Record<string, unknown>,
    reply: Record<string, unknown> | undefined,
    enable: boolean,
  ): Promise<unknown>;
  commentPublic(feed: Record<string, unknown>, content: string): Promise<unknown>;
  replyPublic(
    feed: Record<string, unknown>,
    comment: Record<string, unknown>,
    content: string,
    reply?: Record<string, unknown>,
  ): Promise<unknown>;
  deletePublicComment(
    feed: Record<string, unknown>,
    comment: Record<string, unknown>,
  ): Promise<void>;
  deletePublicReply(
    feed: Record<string, unknown>,
    comment: Record<string, unknown>,
    reply: Record<string, unknown>,
  ): Promise<void>;
  setPublicFollow(feed: Record<string, unknown>, enable: boolean): Promise<unknown>;
  forwardPublicFeed(feed: Record<string, unknown>, reason: string): Promise<unknown>;
}

/**
 * OneBot 适配层的业务能力面。
 *
 * 所有方法都**可选**：没实现的留 `undefined`，注册表据此决定是否注册该
 * action。这样 WeqBot 协议能力涨一点，后端实现一点，OneBot 面自动跟上，
 * 不会出现「注册了但一调就崩」的 action。
 */
export interface OneBotBackend {
  /** 群文件（P8.2）。 */
  groupFile?: GroupFileBackend;
  /** 收藏表情。 */
  customFace?: CustomFaceBackend;
  /** 群待办。 */
  groupTodo?: GroupTodoBackend;
  /** 历史消息。 */
  history?: MessageHistoryBackend;
  /** 合并转发。 */
  forward?: ForwardBackend;
  /** 好友关系 / 单向好友 / 可疑申请。 */
  friendExtra?: FriendExtraBackend;
  /** 群公告。 */
  groupNotice?: GroupNoticeBackend;
  /** 群相册。 */
  groupAlbum?: GroupAlbumBackend;
  /** 群荣誉。 */
  groupHonor?: GroupHonorBackend;
  /** 群打卡。 */
  groupSignin?: GroupSigninBackend;
  /** 群精华。 */
  groupEssence?: GroupEssenceBackend;
  /** 账号侧 web 能力（装扮 / 会员 / 特别关心）。 */
  accountWeb?: AccountWebBackend;
  /** 群策略 / 标签。 */
  groupPolicy?: GroupPolicyBackend;
  /** 表情回应 / 按钮 / 签到 / 系统表情 / 翻译。 */
  interactionExtra?: InteractionExtraBackend;
  /** QQ 空间。 */
  qzone?: QzoneBackend;
  /** 登录信息（`get_login_info`）。 */
  getLoginInfo(): Promise<LoginInfo>;

  sendGroupMessage(groupId: number, message: import('./segments').Segment[]): Promise<SendResult>;
  sendPrivateMessage(
    userId: number,
    message: import('./segments').Segment[],
    tempGroupId?: number,
  ): Promise<SendResult>;

  recall(target: RecallTarget): Promise<void>;

  getFriendList?(): Promise<FriendInfo[]>;
  getGroupList?(): Promise<GroupInfo[]>;
  getGroupInfo?(groupId: number): Promise<GroupInfo>;
  getGroupMemberList?(groupId: number): Promise<GroupMemberInfo[]>;
  getGroupMemberInfo?(groupId: number, userId: number): Promise<GroupMemberInfo>;
  getStrangerInfo?(userId: number): Promise<StrangerInfo>;

  setGroupCard?(groupId: number, userId: number, card: string): Promise<void>;
  setGroupBan?(groupId: number, userId: number, duration: number): Promise<void>;
  setGroupWholeBan?(groupId: number, enable: boolean): Promise<void>;
  setGroupAdmin?(groupId: number, userId: number, enable: boolean): Promise<void>;
  setGroupName?(groupId: number, name: string): Promise<void>;
  setGroupKick?(groupId: number, userId: number, reject: boolean): Promise<void>;
  setGroupLeave?(groupId: number, dissolve: boolean): Promise<void>;
  /** `set_group_special_title`；`duration` 为 `undefined` 表示永久。 */
  setGroupSpecialTitle?(
    groupId: number,
    userId: number,
    title: string,
    duration?: number,
  ): Promise<void>;

  sendLike?(userId: number, times: number): Promise<void>;
  sendPoke?(target: { groupId?: number; userId: number }): Promise<void>;

  setFriendAddRequest?(flag: string, approve: boolean, remark: string): Promise<void>;
  setGroupAddRequest?(flag: string, approve: boolean, reason: string): Promise<void>;

  /** `get_msg`：按 OneBot message_id 取缓存里的原始事件。 */
  getMessage?(messageId: number): Promise<Record<string, unknown> | null>;
  /** `can_send_image` / `can_send_record`。 */
  canSendImage?(): Promise<boolean>;
  canSendRecord?(): Promise<boolean>;

  /** `get_status`：`time` 是适配器启动至今的秒数，由适配层补。 */
  getStatus?(): Promise<{ online: boolean; good: boolean }>;
}

/** `get_version_info` 的返回形状。`app_version` 取本仓库的占位版本。 */
export interface VersionInfo {
  app_name: string;
  app_version: string;
  protocol_version: string;
}

/** 后端实现了哪些能力的摘要，用于诊断与 `--print-capabilities`。 */
export function describeBackend(backend: OneBotBackend): string[] {
  const names: Array<keyof OneBotBackend> = [
    'getLoginInfo',
    'sendGroupMessage',
    'sendPrivateMessage',
    'recall',
    'getFriendList',
    'getGroupList',
    'getGroupInfo',
    'getGroupMemberList',
    'getGroupMemberInfo',
    'getStrangerInfo',
    'setGroupCard',
    'setGroupBan',
    'setGroupWholeBan',
    'setGroupAdmin',
    'setGroupName',
    'setGroupKick',
    'setGroupLeave',
    'setGroupSpecialTitle',
    'sendLike',
    'sendPoke',
    'setFriendAddRequest',
    'setGroupAddRequest',
    'getMessage',
    'canSendImage',
    'canSendRecord',
    'getStatus',
  ];
  const flat = names.filter((name) => typeof backend[name] === 'function');
  const groups: Array<keyof OneBotBackend> = [
    'groupFile',
    'customFace',
    'groupTodo',
    'history',
    'forward',
    'friendExtra',
    'groupPolicy',
    'interactionExtra',
    'qzone',
  ];
  for (const group of groups) {
    if (backend[group]) flat.push(group);
  }
  return flat;
}
