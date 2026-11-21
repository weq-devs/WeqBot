/** 群管理：改名 / 管理员 / 群名片 / 头衔 / 精华 / 头像 / 禁言 / 踢人。 */
export { GetGroupMessagePolicies } from './get-group-message-policies';
export type { GroupMessagePolicySnapshot } from './get-group-message-policies';
export { SetGroupName } from './set-group-name';
export type { SetGroupNameParams } from './set-group-name';
export { SetGroupAdmin } from './set-group-admin';
export type { SetGroupAdminParams } from './set-group-admin';
export { SetGroupMemberCard } from './set-group-member-card';
export type { SetGroupMemberCardParams } from './set-group-member-card';
export { SetGroupSpecialTitle, SPECIAL_TITLE_PERMANENT } from './set-group-special-title';
export type { SetGroupSpecialTitleParams } from './set-group-special-title';
export { SetGroupEssence } from './set-group-essence';
export type { SetGroupEssenceParams } from './set-group-essence';
export {
  GROUP_AVATAR_HIGHWAY_CMD,
  encodeGroupAvatarExtra,
  setGroupAvatar,
} from './set-group-avatar';
export type { SetGroupAvatarParams } from './set-group-avatar';
export { MuteGroupAll, MUTE_ALL_PERMANENT } from './mute-group-all';
export type { MuteGroupAllParams } from './mute-group-all';
export { MuteGroupMember } from './mute-group-member';
export type { MuteGroupMemberParams } from './mute-group-member';
export { KickGroupMember } from './kick-group-member';
export type { KickGroupMemberParams } from './kick-group-member';

export {
  LeaveGroup,
  SetGroupAddOption,
  isQuestionAddType,
  wireAddType,
  GetGroupAtAllRemain,
  GetGroupCategoryTags,
  AddGroupCategoryTag,
  DeleteGroupCategoryTag,
  FetchGroupMemberListPage,
} from './group-settings';
export type {
  LeaveGroupParams,
  SetGroupAddOptionParams,
  AtAllRemain,
  GetGroupAtAllRemainParams,
  GroupCategoryTag,
  GroupCategoryParams,
  ChangeGroupCategoryTagParams,
  GroupMemberListItem,
  GroupMemberListPage,
  FetchGroupMemberListParams,
} from './group-settings';

export { FetchGroupExtInfo, ModifyGroupExtInfo } from './group-ext';
export type {
  FetchGroupExtInfoParams,
  GroupExtRobotOption,
  ModifyGroupExtInfoParams,
} from './group-ext';

export {
  GetAdminPermissions,
  SetAdminPermissions,
  KICK_MEMBER_PER_DAY_CHOICES,
} from './admin-permissions';
export type {
  AdminPermissionsSnapshot,
  GetAdminPermissionsParams,
  GroupAdminPermissionPatch,
  SetAdminPermissionsParams,
} from './admin-permissions';

export {
  FetchGroupDetail,
  SetGroupSearch,
  SetGroupInvitePolicy,
  SetGroupHistoryVisibility,
  SetGroupMemberPermission,
  MEMBER_INVITE_PRIVILEGE_MASK,
  GROUP_HISTORY_VISIBILITY_MASK,
  GROUP_MEMBER_PERMISSION_MASKS,
  mergeMemberInvitePrivilegeFlag,
  decodeMemberInviteAllowed,
  decodeMemberInvitePolicy,
  decodeGroupHistoryVisibility,
  mergeGroupMemberPermission,
  decodeGroupMemberPermissions,
} from './group-admin-settings';
export type {
  GroupDetailInfo,
  SetGroupSearchParams,
  GroupMemberInvitePolicy,
  SetGroupInvitePolicyParams,
  SetGroupHistoryVisibilityParams,
  GroupMemberPermission,
  SetGroupMemberPermissionParams,
} from './group-admin-settings';

export { GetAdminReceiveVerify, SetAdminReceiveVerify } from './receive-verify';
export type {
  GetAdminReceiveVerifyParams,
  SetAdminReceiveVerifyParams,
} from './receive-verify';
