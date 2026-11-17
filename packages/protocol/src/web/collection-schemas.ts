/**
 * 微云 collector.fcg wire schemas（QQ 收藏列表）。
 *
 * 与 SnowLuma `proto-defs/collection.ts` 字段号一致；运行时 schema 描述，
 * 不做构建期代码生成。响应 body 的 operation 在 f2（请求在 f1）。
 */

import { message } from '../protobuf';

export const COLLECTION_REQ_HEAD = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'sequence', tag: 2, type: 'uint32' },
  { name: 'commandType', tag: 3, type: 'uint32' },
  { name: 'operationId', tag: 4, type: 'uint32' },
  { name: 'clientVersion', tag: 5, type: 'uint64' },
  { name: 'platform', tag: 6, type: 'uint32' },
  { name: 'ticketType', tag: 7, type: 'uint32' },
  { name: 'reserved', tag: 10, type: 'uint32' },
  { name: 'ticket', tag: 11, type: 'string' },
  { name: 'field14', tag: 14, type: 'uint32' },
  { name: 'field15', tag: 15, type: 'uint32' },
]);

export const COLLECTION_RESP_HEAD = message([
  { name: 'retCode', tag: 101, type: 'int32' },
  { name: 'retMsg', tag: 102, type: 'string' },
  { name: 'promptMsg', tag: 103, type: 'string' },
]);

export const GET_COLLECTION_LIST_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'timeStamp', tag: 4, type: 'uint64' },
  { name: 'orderType', tag: 5, type: 'uint32' },
  { name: 'groupId', tag: 6, type: 'uint64' },
  { name: 'count', tag: 7, type: 'uint32' },
  { name: 'searchDown', tag: 8, type: 'uint32' },
  { name: 'field9', tag: 9, type: 'uint32' },
]);

export const GET_COLLECTION_CONTENT_REQ = message([
  { name: 'cidList', tag: 1, type: 'string', repeated: true },
]);

export const COLLECTION_REQ_OPERATION = message([
  { name: 'getCollectionList', tag: 20000, type: GET_COLLECTION_LIST_REQ },
  { name: 'getCollectionContent', tag: 20001, type: GET_COLLECTION_CONTENT_REQ },
]);

export const COLLECTION_REQ_BODY = message([
  { name: 'operation', tag: 1, type: COLLECTION_REQ_OPERATION },
]);

export const COLLECTION_AUTHOR = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'numId', tag: 2, type: 'uint64' },
  { name: 'strId', tag: 3, type: 'string' },
  { name: 'groupId', tag: 4, type: 'uint64' },
  { name: 'groupName', tag: 5, type: 'string' },
  { name: 'uid', tag: 6, type: 'string' },
]);

// 图片 / 文件描述符的名字要按线上字段命名：`mapPicture` / `mapFileInfo` 以及
// 下载申请都按名字取值，留成 fieldN 会静默变成空描述符（下载申请直接失效）。
export const COLLECTION_PICTURE = message([
  { name: 'url', tag: 1, type: 'string' },
  { name: 'md5', tag: 2, type: 'bytes' },
  { name: 'sha1', tag: 3, type: 'bytes' },
  { name: 'name', tag: 4, type: 'string' },
  { name: 'note', tag: 5, type: 'string' },
  { name: 'width', tag: 6, type: 'uint32' },
  { name: 'height', tag: 7, type: 'uint32' },
  { name: 'size', tag: 8, type: 'uint32' },
  { name: 'type', tag: 9, type: 'uint32' },
  { name: 'owner', tag: 10, type: COLLECTION_AUTHOR },
  { name: 'picId', tag: 11, type: 'string' },
]);

export const COLLECTION_FILE = message([
  { name: 'src', tag: 1, type: 'uint32' },
  { name: 'uid', tag: 2, type: 'uint64' },
  { name: 'bid', tag: 3, type: 'uint32' },
  { name: 'fid', tag: 4, type: 'string' },
  { name: 'name', tag: 5, type: 'string' },
  { name: 'size', tag: 6, type: 'uint64' },
  { name: 'md5', tag: 7, type: 'bytes' },
  { name: 'sha1', tag: 8, type: 'bytes' },
  { name: 'category', tag: 9, type: 'uint32' },
  { name: 'ntUid', tag: 10, type: 'string' },
]);

export const COLLECTION_TEXT_SUMMARY = message([
  { name: 'text', tag: 1, type: 'string' },
  { name: 'truncated', tag: 2, type: 'bool' },
]);

export const COLLECTION_RICH_MEDIA_SUMMARY = message([
  { name: 'title', tag: 1, type: 'string' },
  { name: 'subTitle', tag: 2, type: 'string' },
  { name: 'brief', tag: 3, type: 'string' },
  { name: 'picList', tag: 4, type: COLLECTION_PICTURE, repeated: true },
  { name: 'contentType', tag: 5, type: 'uint32' },
  { name: 'originalUri', tag: 6, type: 'string' },
  { name: 'publisher', tag: 7, type: 'string' },
  { name: 'richMediaVersion', tag: 8, type: 'uint32' },
]);

export const COLLECTION_GALLERY_SUMMARY = message([
  { name: 'picList', tag: 1, type: COLLECTION_PICTURE, repeated: true },
  { name: 'field2', tag: 2, type: 'string' },
]);

export const COLLECTION_AUDIO_SUMMARY = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'string' },
]);

export const COLLECTION_VIDEO_SUMMARY = message([
  { name: 'field1', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field10', tag: 10, type: 'uint32' },
  { name: 'field20', tag: 20, type: 'uint32' },
  { name: 'picture', tag: 21, type: COLLECTION_PICTURE },
  { name: 'field30', tag: 30, type: 'uint32' },
  { name: 'file', tag: 31, type: COLLECTION_FILE },
]);

export const COLLECTION_FILE_SUMMARY = message([
  { name: 'first', tag: 1, type: COLLECTION_FILE },
  { name: 'second', tag: 2, type: COLLECTION_FILE },
]);

export const COLLECTION_LOCATION_SUMMARY = message([
  { name: 'name', tag: 1, type: 'string' },
  { name: 'latitude', tag: 2, type: 'double' },
  { name: 'longitude', tag: 3, type: 'double' },
  { name: 'altitude', tag: 4, type: 'double' },
  { name: 'field5', tag: 5, type: 'string' },
  { name: 'field6', tag: 6, type: 'string' },
]);

export const COLLECTION_LINK_SUMMARY = message([
  { name: 'url', tag: 1, type: 'string' },
  { name: 'title', tag: 2, type: 'string' },
  { name: 'publisher', tag: 3, type: 'string' },
  { name: 'brief', tag: 4, type: 'string' },
  { name: 'picList', tag: 5, type: COLLECTION_PICTURE, repeated: true },
  { name: 'contentType', tag: 6, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'string' },
]);

export const COLLECTION_SUMMARY = message([
  { name: 'textSummary', tag: 1, type: COLLECTION_TEXT_SUMMARY },
  { name: 'linkSummary', tag: 2, type: COLLECTION_LINK_SUMMARY },
  { name: 'gallerySummary', tag: 3, type: COLLECTION_GALLERY_SUMMARY },
  { name: 'audioSummary', tag: 4, type: COLLECTION_AUDIO_SUMMARY },
  { name: 'videoSummary', tag: 5, type: COLLECTION_VIDEO_SUMMARY },
  { name: 'fileSummary', tag: 6, type: COLLECTION_FILE_SUMMARY },
  { name: 'locationSummary', tag: 7, type: COLLECTION_LOCATION_SUMMARY },
  { name: 'richMediaSummary', tag: 8, type: COLLECTION_RICH_MEDIA_SUMMARY },
]);

export const COLLECTION_ITEM = message([
  { name: 'cid', tag: 1, type: 'string' },
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'status', tag: 3, type: 'uint32' },
  { name: 'author', tag: 4, type: COLLECTION_AUTHOR },
  { name: 'bid', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'string' },
  { name: 'category', tag: 8, type: 'uint32' },
  { name: 'createTime', tag: 9, type: 'uint64' },
  { name: 'collectTime', tag: 10, type: 'uint64' },
  { name: 'modifyTime', tag: 11, type: 'uint64' },
  { name: 'sequence', tag: 12, type: 'uint64' },
  { name: 'field13', tag: 13, type: 'string' },
  { name: 'field14', tag: 14, type: 'string', repeated: true },
  { name: 'summary', tag: 15, type: COLLECTION_SUMMARY },
  { name: 'field16', tag: 16, type: 'bool' },
  { name: 'field17', tag: 17, type: 'uint64' },
  { name: 'shareUrl', tag: 18, type: 'string' },
  { name: 'field19', tag: 19, type: 'uint32' },
  { name: 'customGroupId', tag: 20, type: 'uint32' },
  { name: 'securityBeat', tag: 21, type: 'bool' },
  { name: 'field506', tag: 506, type: 'string' },
]);

export const GET_COLLECTION_LIST_RESP = message([
  { name: 'items', tag: 1, type: COLLECTION_ITEM, repeated: true },
  { name: 'totalCount', tag: 2, type: 'uint32' },
  { name: 'reachedBottom', tag: 3, type: 'uint32' },
]);

// ─────────────── 全文（operation 20001）：标签 = collection type ───────────────
//
// `linkContent` / `galleryContent` / `videoContent` / `fileContent` /
// `locationContent` 在线上就是**原始字节**（native 与 WeQ 都原样存进 db），不要
// 在这里替它们解一层 protobuf —— 解错了会把内容变成空。

export const COLLECTION_TEXT_CONTENT = message([
  { name: 'data', tag: 1, type: 'string' },
  { name: 'hasEmoji', tag: 2, type: 'bool' },
]);

export const COLLECTION_AUDIO_CONTENT = message([{ name: 'data', tag: 1, type: 'bytes' }]);

export const COLLECTION_RICH_MEDIA_CONTENT = message([
  { name: 'richMedia', tag: 1, type: 'bytes' },
  { name: 'rawData', tag: 2, type: 'bytes' },
  { name: 'bizDataList', tag: 3, type: 'bytes', repeated: true },
  { name: 'picList', tag: 4, type: COLLECTION_PICTURE, repeated: true },
  { name: 'fileList', tag: 5, type: COLLECTION_FILE, repeated: true },
]);

export const COLLECTION_CONTENT = message([
  { name: 'textContent', tag: 1, type: COLLECTION_TEXT_CONTENT },
  { name: 'linkContent', tag: 2, type: 'bytes' },
  { name: 'galleryContent', tag: 3, type: 'bytes' },
  { name: 'audioContent', tag: 4, type: COLLECTION_AUDIO_CONTENT },
  { name: 'videoContent', tag: 5, type: 'bytes' },
  { name: 'fileContent', tag: 6, type: 'bytes' },
  { name: 'locationContent', tag: 7, type: 'bytes' },
  { name: 'richMediaContent', tag: 8, type: COLLECTION_RICH_MEDIA_CONTENT },
]);

export const GET_COLLECTION_CONTENT_RESP = message([
  { name: 'contents', tag: 1, type: COLLECTION_CONTENT, repeated: true },
]);

export const COLLECTION_RESP_OPERATION = message([
  { name: 'getCollectionList', tag: 20000, type: GET_COLLECTION_LIST_RESP },
  { name: 'getCollectionContent', tag: 20001, type: GET_COLLECTION_CONTENT_RESP },
]);

export const COLLECTION_RESP_BODY = message([
  { name: 'operation', tag: 2, type: COLLECTION_RESP_OPERATION },
]);

// ─────────────── 附件原文件下载（operation 20014） ───────────────
//
// 头字段与列表**不同**：`version` 是 collector 自己的头版本（0x5f5e1642）、
// `client` 是 0x610，而列表用的是 QQ 的 clientVersion。照抄列表的头会被网关
// 判成「版本不支持」。

export const COLLECTION_DOWNLOAD_REQ_HEAD = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'sequence', tag: 2, type: 'uint32' },
  { name: 'command', tag: 3, type: 'uint32' },
  { name: 'operation', tag: 4, type: 'uint32' },
  { name: 'version', tag: 5, type: 'uint32' },
  { name: 'client', tag: 6, type: 'uint32' },
  { name: 'platform', tag: 7, type: 'uint32' },
  { name: 'ticketType', tag: 10, type: 'uint32' },
  { name: 'ticket', tag: 11, type: 'string' },
  { name: 'field14', tag: 14, type: 'uint32' },
  { name: 'field15', tag: 15, type: 'uint32' },
]);

export const COLLECTION_DOWNLOAD_RESP_HEAD = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'sequence', tag: 2, type: 'uint32' },
  { name: 'command', tag: 3, type: 'uint32' },
  { name: 'operation', tag: 4, type: 'uint32' },
  { name: 'retCode', tag: 101, type: 'int32' },
  { name: 'retMsg', tag: 102, type: 'string' },
  { name: 'promptMsg', tag: 103, type: 'string' },
]);

export const COLLECTION_DOWNLOAD_APPLY_REQ = message([
  { name: 'cid', tag: 1, type: 'string' },
  { name: 'file', tag: 2, type: COLLECTION_FILE },
  { name: 'thumbnail', tag: 3, type: 'bool' },
]);

export const COLLECTION_DOWNLOAD_REQ_OPERATION = message([
  { name: 'apply', tag: 20014, type: COLLECTION_DOWNLOAD_APPLY_REQ },
]);

export const COLLECTION_DOWNLOAD_REQ_BODY = message([
  { name: 'operation', tag: 1, type: COLLECTION_DOWNLOAD_REQ_OPERATION },
]);

export const COLLECTION_DOWNLOAD_ROUTE = message([{ name: 'type', tag: 1, type: 'uint32' }]);

export const COLLECTION_DOWNLOAD_APPLY_RESP = message([
  // native 把 key 原样 hex 拼进 /ftn_handler/：它不是文本。
  { name: 'key', tag: 1, type: 'bytes' },
  { name: 'host', tag: 2, type: 'string' },
  { name: 'port', tag: 3, type: 'uint32' },
  { name: 'cookieName', tag: 4, type: 'string' },
  { name: 'cookieValue', tag: 5, type: 'string' },
  { name: 'route', tag: 6, type: COLLECTION_DOWNLOAD_ROUTE },
  { name: 'httpsHost', tag: 7, type: 'string' },
  { name: 'httpsPort', tag: 8, type: 'uint32' },
]);

export const COLLECTION_DOWNLOAD_RESP_OPERATION = message([
  { name: 'apply', tag: 20014, type: COLLECTION_DOWNLOAD_APPLY_RESP },
]);

export const COLLECTION_DOWNLOAD_RESP_BODY = message([
  { name: 'operation', tag: 2, type: COLLECTION_DOWNLOAD_RESP_OPERATION },
]);
