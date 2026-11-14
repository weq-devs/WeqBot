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

import type { Segment } from './segments';

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
  /** 好友分组编号（`get_friends_with_category` 会带上）。 */
  categoryId?: number;
  /** 好友列表里顺带回的公开资料；服务端没给就省略。 */
  profile?: FriendProfile;
}

/** 好友公开资料（字段名与协议层 `PublicProfileFields` 一致）。 */
export interface FriendProfile {
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
    open: FriendPrivilege[];
    closed: FriendPrivilege[];
  };
}

export interface FriendPrivilege {
  type?: number;
  level?: number;
  flag?: number;
  isBig?: boolean;
  iconUrl?: string;
  deluxeIconUrl?: string;
  jumpUrl?: string;
}

export interface GroupInfo {
  groupId: number;
  groupName: string;
  memberCount: number;
  maxMemberCount: number;
}

/** `get_group_info_ex` / `get_group_detail_info` 的扩展群资料。 */
export interface GroupInfoEx extends GroupInfo {
  /** 当前账号设置的群备注。 */
  groupRemark: string;
  /** 建群时间戳（秒）。 */
  createTime: number;
  /** 群等级；协议层没有该字段时恒 0。 */
  level: number;
  /** 群简介 / 公告预览。 */
  memo: string;
  /** 群简介（不含公告）。 */
  description: string;
  /** 是否全员禁言。 */
  allShut: boolean;
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
  /** 私聊的服务端 NT 序号（历史分页窗口用它；群消息不用）。 */
  ntSequence?: number;
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
  /**
   * 私聊文件下载直链（0xE37_1200）。`userId` 只为对齐 SnowLuma 的参数，
   * 实际以登录账号自己的 uid 取链接。
   */
  getPrivateFileUrl(userId: number | undefined, fileId: string, fileHash: string): Promise<string>;
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
  /** 收藏表情（emoji_id 或 32 位 MD5）→ 图片 URL，`send_custom_face` 用。 */
  resolveCustomFaceUrl(identifier: string): Promise<{ emojiId: string; url: string; md5: string }>;
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

/**
 * 服务端历史里的一条消息（已解码成 OneBot 语义）。
 *
 * **不落盘**：每次 action 调用现拉现转，进程退出即丢（硬约束 13）。
 */
export interface HistoryMessage {
  /** 会话序号：群消息是群 seq，私聊是服务端 NT seq。分页锚点用它。 */
  sequence: number;
  /** wire `msg_id`（十进制字符串）。 */
  wireId: string;
  time: number;
  senderId: number;
  senderName: string;
  /** 已转成 OneBot segment 的内容。 */
  message: Segment[];
  /** 私聊对端的 uid（群聊为空）。 */
  peerUid?: string;
}

/** 历史消息（只读，服务端拉取）。 */
export interface MessageHistoryBackend {
  getGroupHistory(params: {
    groupId: number;
    /** 锚点消息的群 seq；省略时后端用已读探测取会话最新序号。 */
    anchorSequence?: number;
    count: number;
    reverseOrder: boolean;
  }): Promise<HistoryMessage[]>;
  getPrivateHistory(params: {
    userId: number;
    /** 锚点消息的服务端 NT seq；省略时后端用已读探测取会话最新序号。 */
    anchorSequence?: number;
    count: number;
    reverseOrder: boolean;
  }): Promise<HistoryMessage[]>;
}

/** 合并转发里的一个节点（OneBot 语义）。 */
export interface ForwardNode {
  userId?: number;
  nickname?: string;
  message: Segment[];
  time?: number;
  /** 嵌套转发：`content` 本身是一组节点时填这里。 */
  children?: ForwardNode[];
}

/** 拉回来的合并转发节点。 */
export interface ForwardMessageNode {
  userId: number;
  nickname: string;
  time: number;
  /** 节点回显用 id（wire `msgId` 截成有符号 int32；可能与本地 message_id 无关）。 */
  messageId: number;
  /** 节点会话序号（`message_seq`）。 */
  sequence: number;
  /** 节点来自群聊时填群号；私聊节点没有。 */
  groupId?: number;
  message: Segment[];
}

/** NapCat 兼容的转发卡片预览覆盖项（全可选）。 */
export interface ForwardPreview {
  source?: string;
  summary?: string;
  prompt?: string;
  news?: { text: string }[];
}

/** 合并转发目标：群聊 / 私聊二选一；只上传时都为空。 */
export interface ForwardTarget {
  groupId?: number;
  userId?: number;
}

/** 合并转发。 */
export interface ForwardBackend {
  /** 只上传内容，返回服务端 `resId`（不发卡片）。 */
  uploadForward(params: ForwardTarget & { nodes: ForwardNode[] }): Promise<{ resId: string }>;
  /** 上传并发送转发卡片。 */
  sendForward(
    params: ForwardTarget & { nodes: ForwardNode[]; preview?: ForwardPreview },
  ): Promise<{ resId: string; send: SendResult }>;
  /** 按 `resId` 拉取转发内容。 */
  getForwardMessage(resId: string): Promise<ForwardMessageNode[]>;
  /** 单条消息转发：普通元素直接重发，转发卡片按目标场景重新上传。 */
  forwardSingleMessage(params: ForwardTarget & { message: Segment[] }): Promise<SendResult>;
}

/** 会话已读上报。 */
export interface ReadReportBackend {
  markGroupRead(groupId: number): Promise<void>;
  markPrivateRead(userId: number): Promise<void>;
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

/** 群精华（web cgi 列表 + 0xEAC 写操作）。 */
export interface GroupEssenceBackend {
  getEssence(
    groupId: number,
    pageStart: number,
    pageLimit: number,
  ): Promise<{ messages: unknown[]; complete: boolean }>;
  /** `sequence` / `random` 取自消息元信息（`resolveMessageMeta`）。 */
  setEssence(params: {
    groupId: number;
    sequence: number;
    random: number;
    enable: boolean;
  }): Promise<void>;
}

/** 群备注 / 扩展群资料（0xF16、0xFE5_2）。 */
export interface GroupAdminExtraBackend {
  setGroupRemark(groupId: number, remark: string): Promise<void>;
  getGroupInfoEx(groupId: number): Promise<GroupInfoEx>;
}

/** 资料点赞里的一个用户。 */
export interface ProfileLikeUserInfo {
  uid: string;
  /** 资料里没有有效 QQ 号时为 0。 */
  uin: number;
  src: number;
  latestTime: number;
  count: number;
  giftCount: number;
  customId: number;
  lastCharged: number;
  availableCount: number;
  todayVotedCount: number;
  nick: string;
  gender: number;
  age: number;
  isFriend: boolean;
  isVip: boolean;
  isSvip: boolean;
}

/** `get_profile_like`（0x7ED_12 / 13）。 */
export interface ProfileLikeInfo {
  uid: string;
  time: number;
  favorite: {
    totalCount: number;
    lastTime: number;
    todayCount: number;
    users: ProfileLikeUserInfo[];
  };
  vote: {
    totalCount: number;
    newCount: number;
    newNearbyCount: number;
    lastVisitTime: number;
    users: ProfileLikeUserInfo[];
  };
}

/** 账号资料 / 头像 / 在线状态（0x112A、highway 90、0x7ED、trpc SetStatus）。 */
export interface ProfileBackend {
  setProfile(patch: { nickname?: string; personalNote?: string; sex?: 0 | 1 | 2 }): Promise<void>;
  /** 本地路径（含 `file://`）或已读出的字节。 */
  setAvatar(source: string | Uint8Array): Promise<void>;
  getProfileLike(params: {
    userId?: number;
    start: number;
    count: number;
  }): Promise<ProfileLikeInfo>;
  setOnlineStatus(params: {
    status: number;
    extStatus: number;
    batteryStatus: number;
  }): Promise<void>;
  setDiyOnlineStatus(params: { faceId: number; faceType: number; wording: string }): Promise<void>;
}

/** 闪传文件集里的一个文件。 */
export interface FlashFileItem {
  filesetId: string;
  fileName: string;
  origName: string;
  fileSize: number;
  /** 上传 / 分享链接 `https://qfile.qq.com/q/<code>`。 */
  shareUrl: string;
  fileId: string;
  /** 0x93D3 回的缩略图链接；主文件直链需要 0x93D4/0x12A9_200（尚未搬）。 */
  downloadUrl: string;
}

/** 闪传（0x93CF / 0x93D0 / 0x93D1 / 0x93D2 / 0x93D3 / 0x93D7 / 0x9407 / 0x9427）。 */
export interface FlashTransferBackend {
  createTask(
    files: Array<{ path: string; name?: string }>,
    name?: string,
    thumbPath?: string,
  ): Promise<{ filesetId: string; shareUrl: string }>;
  getFilesetInfo(filesetId: string): Promise<FlashFileItem[]>;
  listFilesets(): Promise<FlashFileItem[]>;
  getShareLink(filesetId: string): Promise<string>;
  deleteFile(filesetId: string): Promise<void>;
  renameFile(filesetId: string, newName: string): Promise<void>;
  sendFlashMsg(filesetId: string, target: { userId?: number; groupId?: number }): Promise<void>;
  /** 从分享码 / 官方分享链接解析 fileset id（HTTP 分享页）。 */
  getFilesetIdByCode(shareCode: string): Promise<string>;
}

/** 好友分组 / 推荐联系人卡片 / 图文 Ark。 */
export interface ContactsExtraBackend {
  /** 分组连同组内好友；`withProfile` 只影响是否额外补查资料。 */
  getFriendCategories(withProfile: boolean): Promise<
    Array<{
      categoryId: number;
      categoryName: string;
      memberCount: number;
      friends: FriendInfo[];
    }>
  >;
  setFriendCategory(params: {
    userId: number;
    categoryId?: number;
    categoryName?: string;
  }): Promise<void>;
  /** 只取卡不发送：服务端生成的推荐联系人 / 群 Ark JSON。 */
  getRecommendArk(params: {
    kind: 'qq' | 'group';
    contactId: number;
    phoneNumber?: string;
  }): Promise<string>;
  sendTuwenArk(params: {
    targetId: number;
    peerType: 0 | 1;
    title: string;
    desc: string;
    summary: string;
    previewUrl: string;
    jumpUrl: string;
  }): Promise<{
    peerType: number;
    targetId: number;
    errorCode: number;
    errorMessage: string;
    detail?: { message: string; source: string };
  }>;
}

/** AI 声聊角色（0x929D）。 */
export interface AiVoiceCharacter {
  characterId: string;
  characterName: string;
  previewUrl: string;
}

export interface AiVoiceCategory {
  /** 服务端分类名（推荐 / 搞怪 / 古风 / …）。 */
  category: string;
  characters: AiVoiceCharacter[];
}

/** AI 声聊（0x929D 目录 + 0x929B 合成；仅群聊）。 */
export interface AiVoiceBackend {
  listCharacters(groupId: number, chatType: number): Promise<AiVoiceCategory[]>;
  /**
   * 合成并返回下载 URL。
   *
   * ⚠️ 0x929B 在合成成功后**会把语音发到群里**，不是纯生成接口。
   */
  generate(groupId: number, character: string, text: string, chatType: number): Promise<string>;
  /** 合成后从群历史里找回这条语音的定位信息。 */
  send(groupId: number, character: string, text: string, chatType: number): Promise<SendResult>;
}

/** 杂项：数据库解密密钥（0xCDE_2）。 */
export interface MiscBackend {
  /** `dbPath` 指向账号数据库文件；盐取自 0x2f..0xaf。 */
  requestDecryptKey(dbPath: string): Promise<string>;
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
  getMsgDetail(
    targetUin: number | undefined,
    tid: string,
    pos: number,
    num: number,
  ): Promise<unknown>;
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
  /** 已读上报。 */
  readReport?: ReadReportBackend;
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
  /** 群备注 / 扩展群资料。 */
  groupAdminExtra?: GroupAdminExtraBackend;
  /** 账号资料 / 头像 / 点赞 / 在线状态。 */
  profile?: ProfileBackend;
  /** 好友分组 / 推荐联系人卡片 / 图文 Ark。 */
  contactsExtra?: ContactsExtraBackend;
  /** 数据库解密密钥。 */
  misc?: MiscBackend;
  /** AI 声聊（仅群聊）。 */
  aiVoice?: AiVoiceBackend;
  /** 闪传文件集。 */
  flashTransfer?: FlashTransferBackend;
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
  sendPoke?(target: { groupId?: number; userId: number; targetId?: number }): Promise<void>;

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
    'readReport',
    'friendExtra',
    'groupPolicy',
    'interactionExtra',
    'qzone',
    'groupEssence',
    'groupAdminExtra',
    'profile',
    'contactsExtra',
    'misc',
    'aiVoice',
    'flashTransfer',
  ];
  for (const group of groups) {
    if (backend[group]) flat.push(group);
  }
  return flat;
}
