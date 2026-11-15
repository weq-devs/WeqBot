/**
 * 联系人 / 名单：好友、群的 OIDB 查询，以及群名片解码。
 *
 * 这些命令在 WeQ 的协议包里没有实现（WeQ 直接读本地库），WeqBot 不读库，
 * 所以从 SnowLuma 搬运（2026-11-13）。
 *
 * 群成员列表（0xfe7_3）不在这里 —— WeQ 已有实现，见 `oidb/group-admin/group-settings.ts`；
 * 这里只提供它需要的群名片解码。
 */

export {
  FetchFriendListPage,
  fetchAllFriends,
  type FriendInfo,
  type FriendCategory,
  type FriendListPage,
  type FriendListPageParams,
  type FriendListEntry,
} from './friend-list';
export { FetchGroupList, type GroupInfo } from './group-list';
export { GetGroupShareLink, type GroupShareLinkParams } from './group-share-link';
export {
  fetchAllGroupMembers,
  type FetchAllGroupMembersOptions,
} from './group-member';
export { decodeGroupMemberCard, isBinaryCardText } from './group-member-card';
export {
  decodeBirthday,
  decodeMembership,
  decodePublicProfile,
  PUBLIC_PROFILE_KEYS,
  type ProfilePrivilege,
  type PublicProfileFields,
} from './public-profile';
