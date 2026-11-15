/**
 * qq.com web cgi 层（P8，2026-11-14）。
 *
 * 业务实现**只此一份**：WeqBot 的 OneBot 后端和 WeQ 的桌面功能都从这里 import，
 * WeQ 只保留自己的 `WebCredentialSource`（含「免 attach、只走 pt_login」）。
 *
 * 结构：
 *   - `credential` / `http` / `qzone-pagination`：地基（凭据契约、有界传输、翻页限流）
 *   - `credentials-oidb`：WeqBot 自己的凭据实现（OIDB `0x102a_1` → jump → `0x102a_0`）
 *   - `qzone*` / `group-*` / `dress-*` / `collection`：qq.com cgi（WeQ 与 SnowLuma
 *     能力的并集；搬运时只改 import 接缝）
 *
 * `gift-mall` 是 P1 搬来的纯请求构造（由 `../index` 单独 re-export），执行层在
 * `gift-mall-exec`（2026-11-16 从 WeQ `account/web/gift_mall.ts` 补入）。
 */

export * from './credential';
export * from './credentials-oidb';
export * from './http';
export * from './qzone-pagination';

export * from './qzone';
export * from './qzone_album';
export * from './qzone_comments';
export * from './qzone_detail';
export * from './qzone_forwards';
export * from './qzone_friend_permissions';
export * from './qzone_interaction';
export * from './qzone_people';
export * from './qzone_public';
export * from './qzone_profile';
export * from './qzone_publish';
export * from './qzone_recall';
export * from './qzone_stats';
export * from './qzone-write';

export * from './collection';
export * from './group-album';
export * from './group-album-feed';
export * from './group-album-management';
export * from './group-album-video';
export * from './group-essence';
export * from './group-honor';
export * from './group-notice';
export * from './group-signin';

export * from './dress-kind';
export * from './dress-mall';
export * from './friend-dress';
export * from './friend-mutualmark';
export * from './gift-mall-exec';
export * from './self-dress';
export * from './special-care';
export * from './vip-info';
