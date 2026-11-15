/**
 * QQ 空间「空友爱看」公共空间 —— 推荐流、详情与互动。
 *
 * 移植自 SnowLuma 的同源协议实现（`packages/protocol/src/web/qzone-public.ts`，
 * 已确认真机可用）。这一套**不是**旧空间 CGI：它走 h5 的 http2rpc/gotrpc JSON
 * 网关，把 OIDB 命令号塞进 `x-oidb` 头，服务端据此路由到 trpc 后端：
 *
 *   POST https://h5.qzone.qq.com/http2rpc/gotrpc/v1/<trpc 服务>/<方法>?g_tk=<bkn>
 *   x-web-qua: V1_HT5_QZ_9.9.32_001_IDC_B
 *   x-oidb: {"uint32_command":"0x9741","uint32_service_type":"0"}
 *
 * 响应统一是 `{retcode, message, data}`；`retcode !== 0` 或 `data` 不是对象都算失败，
 * 绝不吞成空列表 —— 否则登录失效会伪装成「没有推荐」。
 *
 * 两条与旧空间 cgi 的关键差异：
 *
 *   1. **动态对象整体透传**。互动/详情只回传 `cell_common.union_id` 和
 *      `cell_feed_transfer`，不允许用旧说说的 tid 拼造目标。上游 `feeds[]` 每项原本
 *      包了一层 `.feed`，这里拆成裸 feed 返回，其余字段一律保留。
 *   2. **翻页游标是本模块封装的**。`GetPublicRecomFeeds` 的续页要同时带
 *      `refresh_id`（首次 `uin_时间戳`）、`attach_info` 和 `last_client_feed_union_id`。
 *      后两者必须跨页沿用，且广告项（`feed_type === 3`）不能作为锚点 —— 只带广告的页
 *      也要把上一条非广告 union 继续往下传，否则会重复或跳条。三者一起 base64url 成
 *      不透明 cursor 并绑 uin，避免调用方拼错或串号。
 *
 * 写路径（推/赞/评论/回复/删除/关注/转发）不套读重试：非零 retcode 或缺少成功回执
 * 字段一律抛错，不把「没回执」当成成功。票据类错码抛 {@link WebAuthError} 交由
 * `withRetry` 换票重试一次，其余（无权限/风控）照常抛普通 Error。
 */

import { encode, message } from '../protobuf';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestJson } from './http';

/** 与其余空间 web 模块同一套「票据不对」判据，好让 withRetry 换票重试。 */
const AUTH_CODES = new Set([-3000, -10000]);

const GATEWAY = 'https://h5.qzone.qq.com/http2rpc/gotrpc/v1';
const REFERER = 'https://h5.qzone.qq.com/pc-qzone/index.html';
/**
 * pc-qzone 网页端的 qua。上游按它决定返回哪套 cell 结构，改动要跟着网页版一起验，
 * 不要随手换成手机版 qua。
 */
const WEB_QUA = 'V1_HT5_QZ_9.9.32_001_IDC_B';

const READER = 'trpc.qzone.feeds_reader.FeedsReader';
const INTERACTION = 'trpc.qzone.interaction_writer.InteractionWriter';
const WRITER = 'trpc.qzone.feeds_writer.FeedsWriter';
const UPVOTE = 'trpc.public_qzone.interaction.UFOComment';
const RELATION = 'trpc.public_qzone.relation.RelationService';
const ENTRANCE = 'trpc.public_qzone.entrance_ctrl.EntranceCtrl';

/** 推荐域（公共空间）的 domain_type。 */
const PUBLIC_DOMAIN_TYPE = 3;

/** 上游保留全部未知字段 —— 这里只约束我们真正会读的那几处。 */
export type QzonePublicFeed = Record<string, unknown>;
export type QzonePublicComment = Record<string, unknown>;
export type QzonePublicJson = Record<string, unknown>;

/** 评论/回复的正文：纯文本，或上游 RichItem 对象数组（富文本原样透传）。 */
export type QzonePublicContent = string | QzonePublicJson[];

/** 评论作者身份。`uid` 缺失时上游仍接受空串，`nick` 用于回显。 */
export interface QzonePublicUser {
  uin: string;
  uid: string;
  nick: string;
}

export interface QzonePublicFeedsPage {
  /** 裸 feed 对象（已去掉上游每项的 `.feed` 包装），其余页面字段保留。 */
  feeds: QzonePublicFeed[];
  has_more: boolean;
  next_cursor: string | null;
  [key: string]: unknown;
}

interface PublicFeedCursor {
  version: 1;
  uin: string;
  refresh_id: string;
  attach_info: string;
  last_client_feed_union_id: QzonePublicJson | null;
}

function isObject(value: unknown): value is QzonePublicJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(method: string, code: unknown, message: string): never {
  const text = `空友 ${method} 失败：retcode=${String(code)} ${message}`.trim();
  throw typeof code === 'number' && AUTH_CODES.has(code)
    ? new WebAuthError(text, code)
    : new Error(text);
}

/** 一次 gotrpc 调用；`retry` 只给幂等读用，写操作一律不重放。 */
async function call(
  cred: WebCredential,
  service: string,
  method: string,
  oidb: string,
  params: QzonePublicJson,
  options: { signal?: AbortSignal; retry?: boolean } = {},
): Promise<QzonePublicJson> {
  const [command, serviceType] = oidb.split('_');
  if (!command || serviceType === undefined)
    throw new Error(`空友 ${method} 的 oidb 标识无效：${oidb}`);
  const bkn = computeBkn(cred.pskey || cred.skey);
  const result = await webRequestJson<unknown>(`${GATEWAY}/${service}/${method}?g_tk=${bkn}`, {
    method: 'POST',
    cookie: cookieHeader(cred),
    headers: {
      'Content-Type': 'application/json',
      Referer: REFERER,
      'x-web-qua': WEB_QUA,
      'x-oidb': JSON.stringify({
        uint32_command: command,
        uint32_service_type: serviceType,
      }),
    },
    body: JSON.stringify(params),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.retry ? { retry: WEB_READ_RETRY } : {}),
  });

  if (!isObject(result)) throw new Error(`空友 ${method} 响应无效`);
  if (result.retcode !== 0 || !isObject(result.data)) {
    const message = typeof result.message === 'string' ? result.message : '';
    fail(method, result.retcode ?? 'missing', message);
  }
  return result.data;
}

/**
 * 详情与互动的目标参数 —— 只带上游给的身份，不允许调用方另造。
 * `cell_feed_transfer` 必须原样回传，它是上游跨域/跨端识别的凭据。
 */
function feedParams(feed: QzonePublicFeed, method: string): QzonePublicJson {
  const common = feed.cell_common;
  const union = isObject(common) ? common.union_id : undefined;

  if (!isObject(union) || !Object.keys(union).length)
    throw new Error(
      `空友 ${method} 目标缺少 cell_common.union_id，请使用推荐列表或详情返回的完整动态`,
    );

  return {
    union_id: union,
    ...(feed.cell_feed_transfer === undefined
      ? {}
      : { cell_feed_transfer: feed.cell_feed_transfer }),
  };
}

function authorOf(feed: QzonePublicFeed): { uid: string; uin: string } {
  const user = isObject(feed.cell_user_info) ? feed.cell_user_info.user : undefined;
  const uid = isObject(user) && typeof user.uid === 'string' ? user.uid.trim() : '';
  const uin = isObject(user) && typeof user.uin === 'string' ? user.uin.trim() : '';
  return { uid, uin };
}

function encodeCursor(state: PublicFeedCursor): string {
  const cursor = Buffer.from(JSON.stringify(state)).toString('base64url');
  if (cursor.length > 65_536) throw new Error('空友推荐分页游标过大');
  return cursor;
}

function decodeCursor(cursor: string, uin: string): PublicFeedCursor {
  if (!cursor || cursor.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error('无效的空友推荐 cursor');

  let value: unknown;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    // 非规范 base64 能解码出同一份字节，先回写比对，避免两个字符串代表同一游标。
    if (bytes.toString('base64url') !== cursor) throw new Error('non-canonical encoding');
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('无效的空友推荐 cursor');
  }

  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.uin !== uin ||
    typeof value.refresh_id !== 'string' ||
    !value.refresh_id ||
    typeof value.attach_info !== 'string' ||
    !(value.last_client_feed_union_id === null || isObject(value.last_client_feed_union_id))
  )
    throw new Error('空友推荐 cursor 无效或不属于当前账号');

  return {
    version: 1,
    uin,
    refresh_id: value.refresh_id,
    attach_info: value.attach_info,
    last_client_feed_union_id: value.last_client_feed_union_id,
  };
}

/** 当前账号是否有爱看入口、能否「推」。返回上游 entrances 原样对象。 */
export async function getQzonePublicCapabilities(
  cred: WebCredential,
  signal?: AbortSignal,
): Promise<QzonePublicJson> {
  const data = await call(
    cred,
    ENTRANCE,
    'BatchEntranceWhitelist',
    '0x9741_0',
    { uins: [cred.uin], entrance_types: [1, 15] },
    { signal, retry: true },
  );
  const result = Array.isArray(data.results)
    ? data.results.find((entry) => isObject(entry) && String(entry.uin) === cred.uin)
    : undefined;

  if (!isObject(result) || !isObject(result.entrances))
    throw new Error('空友入口查询响应缺少当前账号的 entrances');

  return result.entrances;
}

interface HomeFeedCursor {
  version: 1;
  kind: 'home';
  uin: string;
  host_uin: string;
  attach_info: string;
}

/** 空间主页动态（自己或有权访问的他人主页）。 */
export async function getQzoneHomeFeeds(
  cred: WebCredential,
  targetUin?: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<QzonePublicFeedsPage> {
  const hostUin = targetUin ?? cred.uin;
  let attachInfo = '';

  if (cursor !== undefined) {
    if (!cursor || cursor.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('无效的空间主页 cursor');
    }
    let value: unknown;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.toString('base64url') !== cursor) throw new Error('non-canonical encoding');
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('无效的空间主页 cursor');
    }
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.kind !== 'home' ||
      value.uin !== cred.uin ||
      value.host_uin !== hostUin ||
      typeof value.attach_info !== 'string' ||
      !value.attach_info
    ) {
      throw new Error('空间主页 cursor 无效或不属于当前账号及主页');
    }
    attachInfo = value.attach_info;
  }

  const data = await call(
    cred,
    READER,
    'GetMainPageFeeds',
    '0x9794_2',
    {
      host_uid: '',
      host_uin: hostUin,
      attach_info: attachInfo,
      refresh_attach_info: '',
      feed_action_domain_type: 1,
    },
    { signal, retry: true },
  );

  if (!Array.isArray(data.feeds) || typeof data.has_more !== 'boolean') {
    throw new Error('空间主页动态分页响应异常');
  }
  const feeds = data.feeds.map((entry) => {
    if (!isObject(entry) || !isObject(entry.feed)) {
      throw new Error('空间主页动态响应异常');
    }
    return entry.feed;
  });

  let nextCursor: string | null = null;
  if (data.has_more) {
    if (
      typeof data.attach_info !== 'string' ||
      !data.attach_info ||
      data.attach_info === attachInfo
    ) {
      throw new Error('空间主页动态分页未推进');
    }
    const state: HomeFeedCursor = {
      version: 1,
      kind: 'home',
      uin: cred.uin,
      host_uin: hostUin,
      attach_info: data.attach_info,
    };
    nextCursor = Buffer.from(JSON.stringify(state)).toString('base64url');
    if (nextCursor.length > 65_536) throw new Error('空间主页分页游标过大');
  }

  return { ...data, feeds, has_more: data.has_more, next_cursor: nextCursor };
}

const UGC_ID = message([
  { name: 'appId', tag: 1, type: 'int64' },
  { name: 'uin', tag: 2, type: 'int64' },
  { name: 'publishTime', tag: 3, type: 'int64' },
  { name: 'field4', tag: 4, type: 'string', force: true },
  { name: 'field5', tag: 5, type: 'string', force: true },
  { name: 'field6', tag: 6, type: 'string' },
  { name: 'tid', tag: 8, type: 'string' },
]);

export interface QzoneFeedDetail {
  /** 原始 cells，可直接传给 getQzoneShareArk。 */
  feed: QzonePublicFeed;
  attach_info: string | null;
  [key: string]: unknown;
}

/** 按 24 位十六进制 tid 读取完整空间动态。 */
export async function getQzoneFeedDetail(
  cred: WebCredential,
  tid: string,
  signal?: AbortSignal,
): Promise<QzoneFeedDetail> {
  if (tid.length !== 24 || !/^[0-9a-f]{24}$/i.test(tid)) {
    throw new Error('空间说说 tid 必须是 24 位十六进制编号');
  }
  const feedId = tid.toLowerCase();
  const identity = Buffer.from(feedId, 'hex');
  const ugcId = encode(UGC_ID, {
    appId: 311n,
    uin: BigInt(identity.readUInt32LE(0)),
    publishTime: BigInt(identity.readUInt32LE(4)),
    field4: '',
    field5: '',
    field6: '0',
    tid: feedId,
  });
  const data = await call(
    cred,
    READER,
    'GetFeedDetail',
    '0x97b1_1',
    {
      union_id: {
        feed_id: feedId,
        ugc_id: Buffer.from(ugcId).toString('base64'),
        adv_id: null,
      },
      feed_action_domain_type: 1,
      from_page: 1,
    },
    { signal, retry: true },
  );
  const wrapper = data.feed;
  if (!isObject(wrapper) || !isObject(wrapper.feed)) {
    throw new Error('空间详情响应缺少完整动态 feed.feed');
  }
  const feed = wrapper.feed;
  const common = feed.cell_common;
  const unionId = isObject(common) ? common.union_id : undefined;
  if (
    !isObject(unionId) ||
    typeof unionId.feed_id !== 'string' ||
    unionId.feed_id.toLowerCase() !== feedId
  ) {
    throw new Error('空间详情返回的动态编号与请求不符');
  }
  if (data.attach_info != null && typeof data.attach_info !== 'string') {
    throw new Error('空间详情评论游标格式异常');
  }
  return { ...data, feed, attach_info: data.attach_info ?? null };
}

export interface QzoneShareArk {
  ark: string;
  requires_confirmation: boolean;
  notice: string | null;
}

/** 用完整动态生成分享卡片。 */
export async function getQzoneShareArk(
  cred: WebCredential,
  feed: QzonePublicFeed,
  signal?: AbortSignal,
): Promise<QzoneShareArk> {
  const operation = feed.cell_operation;
  const share = isObject(operation) ? operation.share_outside : undefined;
  const resource = isObject(share) ? share.share_access_resource : undefined;
  const common = feed.cell_common;
  const mask = isObject(common) ? common.operate_mask : undefined;

  if (mask !== undefined && (typeof mask !== 'number' || !Number.isSafeInteger(mask) || mask < 0)) {
    throw new Error('空间动态分享权限数据异常');
  }
  if (typeof mask === 'number' && (mask & (1 << 17)) !== 0) {
    const reason =
      isObject(share) && typeof share.share_out_button_toast === 'string'
        ? share.share_out_button_toast
        : '该空间动态暂不支持分享';
    throw new Error(reason);
  }
  if (
    !isObject(resource) ||
    typeof resource.busi_id !== 'string' ||
    !resource.busi_id ||
    typeof resource.resource_id !== 'string' ||
    !resource.resource_id ||
    typeof feed.cell_feed_transfer !== 'string' ||
    !feed.cell_feed_transfer
  ) {
    throw new Error('空间动态缺少分享信息，请传入主页、详情或推荐列表返回的完整动态');
  }

  const data = await call(
    cred,
    'trpc.qq.share.Service',
    'CreateShare',
    '0x9409_1',
    {
      info: {
        busi_id: resource.busi_id,
        resource_id: resource.resource_id,
        template: 'ark_busi_select',
        busi_data: feed.cell_feed_transfer,
        plat: 1,
        target: 3,
      },
    },
    { signal },
  );

  if (data.err !== undefined && data.err !== null) {
    if (!isObject(data.err) || (data.err.code !== undefined && typeof data.err.code !== 'number')) {
      throw new Error('空间分享业务响应异常');
    }
    if (data.err.code !== undefined && data.err.code !== 0) {
      const message = typeof data.err.msg === 'string' ? data.err.msg : '';
      throw new Error(`空间分享失败: ${data.err.code} ${message}`.trim());
    }
  }
  if (typeof data.template_data !== 'string' || !data.template_data.trim()) {
    throw new Error('空间分享未返回卡片');
  }
  const ark: unknown = JSON.parse(data.template_data);
  if (!isObject(ark)) throw new Error('空间分享返回的卡片格式异常');

  let requiresConfirmation = false;
  let notice: string | null = null;
  if (data.info !== undefined) {
    if (!isObject(data.info)) throw new Error('空间分享提示格式异常');
    const encoded = data.info.busi_data;
    if (encoded !== undefined && encoded !== '') {
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error('空间分享提示编码异常');
      }
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        throw new Error('空间分享提示编码异常');
      }
      const permission: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(decoded),
      );
      if (permission !== null) {
        if (
          !isObject(permission) ||
          (permission.need_break !== undefined && typeof permission.need_break !== 'boolean')
        ) {
          throw new Error('空间分享提示格式异常');
        }
        requiresConfirmation = permission.need_break === true;
        if (
          isObject(permission.tips) &&
          typeof permission.tips.content === 'string' &&
          permission.tips.content
        ) {
          notice = permission.tips.content;
        }
        if (requiresConfirmation && !notice) {
          notice = '你的空间有权限，分享出去的页面所有人都可以看。';
        }
      }
    }
  }

  return { ark: data.template_data, requires_confirmation: requiresConfirmation, notice };
}

/** 推荐流首页或续页。`cursor` 必须是上一次返回的 `next_cursor`，绑定当前账号。 */
export async function getQzonePublicFeeds(
  cred: WebCredential,
  cursor?: string,
  signal?: AbortSignal,
): Promise<QzonePublicFeedsPage> {
  const state: PublicFeedCursor =
    cursor === undefined
      ? {
          version: 1,
          uin: cred.uin,
          refresh_id: `${cred.uin}_${Date.now()}`,
          attach_info: '',
          last_client_feed_union_id: null,
        }
      : decodeCursor(cursor, cred.uin);

  const data = await call(
    cred,
    READER,
    'GetPublicRecomFeeds',
    '0x9a38_0',
    {
      refresh_id: state.refresh_id,
      // 首页不带续页参数，与网页端一致。
      ...(cursor === undefined
        ? {}
        : {
            attach_info: state.attach_info,
            ...(state.last_client_feed_union_id === null
              ? {}
              : { last_client_feed_union_id: state.last_client_feed_union_id }),
          }),
    },
    { signal, retry: true },
  );

  if (!Array.isArray(data.feeds) || typeof data.has_more !== 'boolean')
    throw new Error('空友 GetPublicRecomFeeds 分页响应异常');

  const feeds = data.feeds.map((entry) => {
    if (!isObject(entry) || !isObject(entry.feed))
      throw new Error('空友 GetPublicRecomFeeds 动态响应异常');
    return entry.feed;
  });

  // 广告项（feed_type 3）不能当锚点；只含广告的页仍沿用上一页的锚继续往下传。
  let lastUnion = state.last_client_feed_union_id;
  for (const feed of feeds) {
    const common = feed.cell_common;
    if (isObject(common) && common.feed_type !== 3 && isObject(common.union_id))
      lastUnion = common.union_id;
  }

  let nextCursor: string | null = null;
  if (data.has_more) {
    if (typeof data.attach_info !== 'string')
      throw new Error('空友 GetPublicRecomFeeds 分页缺少 attach_info');
    nextCursor = encodeCursor({
      ...state,
      attach_info: data.attach_info,
      last_client_feed_union_id: lastUnion,
    });
  }

  return { ...data, feeds, has_more: data.has_more, next_cursor: nextCursor };
}

/** 动态详情；首批评论在返回的 `feed.feed.cell_comment.comments`。 */
export async function getQzonePublicFeedDetail(
  cred: WebCredential,
  feed: QzonePublicFeed,
  signal?: AbortSignal,
): Promise<QzonePublicJson> {
  return call(
    cred,
    READER,
    'GetFeedDetail',
    '0x97b1_1',
    {
      ...feedParams(feed, 'GetFeedDetail'),
      feed_action_domain_type: PUBLIC_DOMAIN_TYPE,
      from_page: 1,
    },
    { signal, retry: true },
  );
}

/** 继续读评论；`cursor` = 详情或上一评论页的 `attach_info`。 */
export async function getQzonePublicComments(
  cred: WebCredential,
  feed: QzonePublicFeed,
  cursor: string,
  signal?: AbortSignal,
): Promise<QzonePublicJson> {
  return call(
    cred,
    READER,
    'GetComment',
    '0x9bfd_1',
    { ...feedParams(feed, 'GetComment'), attach_info: cursor },
    { signal, retry: true },
  );
}

/**
 * 继续读某条评论的回复。首次可省略 `cursor`，用评论自带的 `reply_attach_info`；
 * 之后传上一回复页的 `reply_attach_info`。
 */
export async function getQzonePublicReplies(
  cred: WebCredential,
  feed: QzonePublicFeed,
  comment: QzonePublicComment,
  cursor: string,
  pageSize = 20,
  signal?: AbortSignal,
): Promise<QzonePublicJson> {
  const first = typeof comment.reply_attach_info === 'string' ? comment.reply_attach_info : '';

  return call(
    cred,
    READER,
    'GetReplies',
    '0x9bfe_1',
    {
      ...feedParams(feed, 'GetReplies'),
      cur_comment: comment,
      comment_attach_info: '',
      reply_attach_info: cursor || first,
      page_size: pageSize,
    },
    { signal, retry: true },
  );
}

/** 「推」与普通「赞」是两个独立接口，别混用。 */
export async function setQzonePublicUpvote(
  cred: WebCredential,
  feed: QzonePublicFeed,
  enable: boolean,
): Promise<QzonePublicJson> {
  const data = await call(
    cred,
    UPVOTE,
    enable ? 'Upvote' : 'Downvote',
    enable ? '0x9d18_1' : '0x9d19_1',
    feedParams(feed, 'Upvote'),
  );

  if (!data.upvote) throw new Error('空友推操作响应缺少 upvote');
  return data;
}

async function setPublicLike(
  cred: WebCredential,
  feed: QzonePublicFeed,
  likeKey: unknown,
  likeType: number,
  enable: boolean,
): Promise<QzonePublicJson> {
  if (typeof likeKey !== 'string' || !likeKey) throw new Error('空友点赞目标缺少 like_key');

  const method = enable ? 'DoLike' : 'UnLike';
  const data = await call(cred, INTERACTION, method, enable ? '0x9699_1' : '0x969c_1', {
    ...feedParams(feed, method),
    like_key: likeKey,
    like_type: likeType,
  });

  if (!data.like) throw new Error('空友点赞响应缺少 like');
  return data;
}

/** 点赞整条动态（`like_type` 1）。 */
export async function setQzonePublicLike(
  cred: WebCredential,
  feed: QzonePublicFeed,
  enable: boolean,
): Promise<QzonePublicJson> {
  const common = feed.cell_common;
  return setPublicLike(cred, feed, isObject(common) ? common.cur_like_key : undefined, 1, enable);
}

/** 给评论点赞（`like_type` 2）；给了 `reply` 就改为给该回复点赞（`like_type` 3）。 */
export async function setQzonePublicCommentLike(
  cred: WebCredential,
  feed: QzonePublicFeed,
  comment: QzonePublicComment,
  enable: boolean,
  reply?: QzonePublicComment,
): Promise<QzonePublicJson> {
  const like = (reply ?? comment).like;
  return setPublicLike(cred, feed, isObject(like) ? like.id : undefined, reply ? 3 : 2, enable);
}

/** 字符串正文编码成单个文本 RichItem；富文本数组原样透传。 */
function richContent(content: QzonePublicContent): QzonePublicJson[] {
  return typeof content === 'string' ? [{ type: 0, content }] : content;
}

export async function commentQzonePublic(
  cred: WebCredential,
  feed: QzonePublicFeed,
  user: QzonePublicUser,
  content: QzonePublicContent,
): Promise<QzonePublicJson> {
  const data = await call(cred, INTERACTION, 'AddComment', '0x9676_1', {
    ...feedParams(feed, 'AddComment'),
    comment: { user, content: richContent(content) },
  });

  if (!data.comment) throw new Error('空友评论响应缺少 comment');
  return data;
}

export async function replyQzonePublic(
  cred: WebCredential,
  feed: QzonePublicFeed,
  user: QzonePublicUser,
  comment: QzonePublicComment,
  content: QzonePublicContent,
  reply?: QzonePublicComment,
): Promise<QzonePublicJson> {
  const targetUser = isObject(reply?.user) ? reply.user : comment.user;
  if (!isObject(targetUser)) throw new Error('空友评论或回复缺少 user');

  const data = await call(cred, INTERACTION, 'AddReply', '0x9677_1', {
    ...feedParams(feed, 'AddReply'),
    comment,
    reply: { content: richContent(content), target_user: targetUser, user },
  });

  if (!data.reply) throw new Error('空友回复响应缺少 reply');
  return data;
}

export async function deleteQzonePublicComment(
  cred: WebCredential,
  feed: QzonePublicFeed,
  comment: QzonePublicComment,
): Promise<QzonePublicJson> {
  return call(cred, INTERACTION, 'DeleteComment', '0x9989_0', {
    ...feedParams(feed, 'DeleteComment'),
    comment,
  });
}

export async function deleteQzonePublicReply(
  cred: WebCredential,
  feed: QzonePublicFeed,
  comment: QzonePublicComment,
  reply: QzonePublicComment,
): Promise<QzonePublicJson> {
  return call(cred, INTERACTION, 'DeleteReply', '0x998a_0', {
    ...feedParams(feed, 'DeleteReply'),
    comment,
    reply,
  });
}

/**
 * 关注/取关推荐动态的作者。推荐域（`domain_type` 3）优先用 uid，其余用 uin；
 * 失败在**内层** `ret_code`，外层 retcode 仍是 0，必须单独判。
 */
export async function setQzonePublicFollow(
  cred: WebCredential,
  feed: QzonePublicFeed,
  enable: boolean,
): Promise<QzonePublicJson> {
  const params = feedParams(feed, 'Follow');
  const { uid, uin } = authorOf(feed);
  const useUid =
    (isObject(feed.cell_common) && feed.cell_common.domain_type === 3 && !!uid) || !uin;

  if (useUid ? !uid : !uin) throw new Error('空友动态缺少作者 uid/uin');

  const union = params.union_id as QzonePublicJson;
  const data = await call(
    cred,
    RELATION,
    enable ? 'Follow' : 'Unfollow',
    enable ? '0x9d1a_1' : '0x9d1b_1',
    {
      follow_from_type: 1,
      ...(useUid ? { target_uid: uid } : { target_uin: uin }),
      ...(union.uf_key ? { follow_feed_id: union.uf_key } : {}),
      ...(feed.cell_feed_transfer === undefined
        ? {}
        : { cell_feed_transfer: feed.cell_feed_transfer }),
    },
  );

  if (
    data.ret_code !== undefined &&
    data.ret_code !== null &&
    data.ret_code !== 0 &&
    data.ret_code !== '0'
  ) {
    const message = typeof data.ret_msg === 'string' ? data.ret_msg : '';
    throw new Error(`空友关注失败：ret_code=${String(data.ret_code)} ${message}`.trim());
  }

  return data;
}

/** 转发推荐动态；`reason` 是转发语（可空串）。 */
export async function forwardQzonePublicFeed(
  cred: WebCredential,
  feed: QzonePublicFeed,
  reason = '',
): Promise<QzonePublicJson> {
  return call(cred, WRITER, 'ForwardFeed', '0x969a_1', {
    ...feedParams(feed, 'ForwardFeed'),
    reason,
  });
}
