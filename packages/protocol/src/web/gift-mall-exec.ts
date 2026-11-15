/**
 * QQ 礼物商城执行函数（P8.5 补齐）。
 *
 * 搬运自 WeQ `packages/service/src/account/web/gift_mall.ts`（2026-11-16）：
 * 请求体构造留在 {@link ./gift-mall}（那部分本来就在本包），这里只把
 * `(cred, ...) → 结果` 的执行层补上——传输换成 {@link ./http}、错误换成
 * `WebAuthError`。**写操作（下单）不做自动重试**，否则网络超时会重放成重复订单。
 *
 * 只有两条域：查询走 `club.vip.qq.com`，下单走 `act.qzone.qq.com`。两者都用
 * `p_skey` 算 `g_tk`，所以凭据来源固定 `vip.qq.com` 域。
 */

import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import {
  GIFT_MALL_ENDPOINTS,
  buildGiftMallBuyItemRequest,
  buildGiftMallHomePageExtraRequest,
  buildGiftMallHomePageGiftListRequest,
  buildGiftMallSearchRequest,
  buildGiftMallSingleGiftInfoRequest,
  buildGiftMallVipInfoRequest,
  buildGiftMallWallRequest,
  type GiftMallAIDiscStatusResponse,
  type GiftMallBuyItemOptions,
  type GiftMallBuyItemRequest,
  type GiftMallBuyItemResponse,
  type GiftMallGift,
  type GiftMallGiftListOptions,
  type GiftMallGiftListResponse,
  type GiftMallHomePageExtraResponse,
  type GiftMallSearchOptions,
  type GiftMallSearchResponse,
  type GiftMallSingleGiftInfoResponse,
  type GiftMallVipInfoResponse,
  type GiftMallWallOptions,
  type GiftMallWallResponse,
} from './gift-mall';
import { WEB_READ_RETRY, WebRequestError, webRequestJson } from './http';

/** 下单所在域；与查询域不同，`g_tk` 仍用同一份 p_skey 计算。 */
const BUY_HOST = 'https://act.qzone.qq.com';
const HOST = 'https://club.vip.qq.com';
const AUTH_CODES = new Set([-3000, -10000]);
const REFERER = 'https://club.vip.qq.com/kuikly/vas_qqvip_gift_shop/2630';
/**
 * 商城的 UA 必须与客户端一致：它是 Kuikly 页面，服务端按 UA 分派。
 * 与 WeQ 保持逐字相同（抓包来源），不要"优化"成通用浏览器 UA。
 */
const GIFT_MALL_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; 2109119BC Build/TKQ1.221114.001) V1_AND_SQ_9.3.75_16580_YYB_D QQ/9.3.75.42350 NetType/4G WebP/0.4.1 AppId/537397776 Pixel/1080 StatusBarHeight/95 SimpleUISwitch/0 QQTheme/1000 QQExt/0 StudyMode/0 CurrentMode/0 CurrentFontScale/1.0 GlobalDensityScale/0.9818182 AllowLandscape/false InMagicWin/0';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 回包里的业务错误：`-3000` / `-10000` 是登录态问题，交给 `withRetry` 换票。 */
function responseError(response: unknown): Error | undefined {
  const data = record(response);
  if (!data || (typeof data.code !== 'number' && typeof data.code !== 'string')) return undefined;
  const code = Number(data.code);
  if (!Number.isFinite(code) || code === 0) return undefined;
  const message = typeof data.message === 'string' ? data.message : '礼物商城请求失败';
  return AUTH_CODES.has(code)
    ? new WebAuthError(`礼物商城登录态失效：${message}`, code)
    : new Error(`礼物商城请求失败（${code}）：${message}`);
}

async function postGiftMall<T>(cred: WebCredential, endpoint: string, body: unknown): Promise<T> {
  let response: unknown;
  try {
    response = await webRequestJson<unknown>(`${HOST}${endpoint}?g_tk=${computeBkn(cred.pskey)}`, {
      method: 'POST',
      cookie: cookieHeader(cred),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': GIFT_MALL_UA,
        Referer: REFERER,
      },
      body: JSON.stringify(body),
      retry: WEB_READ_RETRY,
    });
  } catch (error) {
    if (error instanceof WebRequestError && (error.status === 401 || error.status === 403)) {
      throw new WebAuthError('礼物商城登录态失效。', error.status);
    }
    throw error;
  }

  const error = responseError(response);
  if (error) throw error;
  return response as T;
}

function requireList(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`礼物商城响应缺少${label}列表。`);
}

/** 读取首页推荐、愿望单和服务端页签。 */
export async function fetchGiftMallHomePageExtraInfo(
  cred: WebCredential,
  toUin: number,
): Promise<GiftMallHomePageExtraResponse> {
  const response = await postGiftMall<GiftMallHomePageExtraResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.homePageExtraInfo,
    buildGiftMallHomePageExtraRequest(toUin),
  );
  requireList(response.wishList, '愿望单');
  requireList(response.crowdRecomList, '推荐礼物');
  requireList(response.tabList, '页签');
  return response;
}

/** 读取首页礼物列表。空 `subTabName` 使用服务端默认的「最近上新」。 */
export async function fetchGiftMallGiftList(
  cred: WebCredential,
  toUin: number,
  options: GiftMallGiftListOptions = {},
): Promise<GiftMallGiftListResponse> {
  const response = await postGiftMall<GiftMallGiftListResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.homePageGiftList,
    buildGiftMallHomePageGiftListRequest(toUin, options),
  );
  requireList(response.giftList, '礼物');
  if (typeof response.attachInfo !== 'string' || typeof response.isEnd !== 'boolean') {
    throw new Error('礼物商城分页响应缺少游标或结束标记。');
  }
  return response;
}

/** 搜索礼物；页号与游标原样交给服务端，不自行猜测分页规则。 */
export async function searchGiftMall(
  cred: WebCredential,
  options: GiftMallSearchOptions,
): Promise<GiftMallSearchResponse> {
  const response = await postGiftMall<GiftMallSearchResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.searchGifts,
    buildGiftMallSearchRequest(options),
  );
  requireList(response.giftList, '搜索结果');
  if (typeof response.attachInfo !== 'string' || typeof response.isEnd !== 'boolean') {
    throw new Error('礼物搜索分页响应缺少游标或结束标记。');
  }
  return response;
}

/** 查询一个礼物针对收礼人的详情与资格状态。 */
export async function fetchGiftMallSingleGiftInfo(
  cred: WebCredential,
  giftId: string | number,
  toUin: number,
): Promise<GiftMallSingleGiftInfoResponse> {
  const response = await postGiftMall<GiftMallSingleGiftInfoResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.singleGiftInfo,
    buildGiftMallSingleGiftInfoRequest(giftId, toUin),
  );
  if (!record(response.giftInfo)) throw new Error('礼物详情响应缺少礼物信息。');
  return response;
}

/** 查询当前账号对礼物商城的 VIP / SVIP 权益。 */
export async function fetchGiftMallVipInfo(
  cred: WebCredential,
  giftId: string | number,
): Promise<GiftMallVipInfoResponse> {
  const response = await postGiftMall<GiftMallVipInfoResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.vipInfo,
    buildGiftMallVipInfoRequest(giftId),
  );
  if (!record(response.info)) throw new Error('礼物商城会员信息响应缺少权益信息。');
  return response;
}

/** 读取送出或收到的礼物墙；游标和时间字段由调用方按响应原样传回。 */
export async function fetchGiftMallWall(
  cred: WebCredential,
  options: GiftMallWallOptions,
): Promise<GiftMallWallResponse> {
  const response = await postGiftMall<GiftMallWallResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.sendRecvWallList,
    buildGiftMallWallRequest(options),
  );
  requireList(response.giftsList, '礼物墙');
  if (
    typeof response.extInfo !== 'string' ||
    typeof response.isEnd !== 'boolean' ||
    typeof response.beginTime !== 'number'
  ) {
    throw new Error('礼物墙分页响应缺少游标或时间字段。');
  }
  return response;
}

/** 读取礼物商城关联的 AI 内容披露状态。 */
export async function fetchGiftMallAIDiscStatus(
  cred: WebCredential,
): Promise<GiftMallAIDiscStatusResponse> {
  const response = await postGiftMall<GiftMallAIDiscStatusResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.aiDiscStatus,
    {},
  );
  requireList(response.statusList, 'AI 内容披露状态');
  return response;
}

/**
 * 提交一次礼物下单 / 赠送请求。返回的只是**支付所需信息**，不是已付款。
 *
 * 写请求只发一次：网络超时后重放会产生重复订单，所以这里不用 `WEB_READ_RETRY`。
 * `beforeSend` 由调用方注入（WeQ 用它记审计日志），失败不重试也不切端点。
 */
export async function submitGiftMallBuyItem(
  cred: WebCredential,
  request: GiftMallBuyItemRequest,
  beforeSend?: () => void,
): Promise<GiftMallBuyItemResponse> {
  beforeSend?.();
  let response: unknown;
  try {
    response = await webRequestJson<unknown>(`${BUY_HOST}${GIFT_MALL_ENDPOINTS.buyItem}`, {
      method: 'POST',
      cookie: cookieHeader(cred),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': GIFT_MALL_UA,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (error instanceof WebRequestError && (error.status === 401 || error.status === 403)) {
      throw new WebAuthError('礼物下单登录态失效；请求未自动重放。', error.status);
    }
    throw error;
  }

  const error = responseError(response);
  if (error) throw error;
  const data = record(response);
  if (!data || typeof data.code !== 'number' || !record(data.data)) {
    throw new Error('礼物下单响应格式异常。');
  }
  return response as GiftMallBuyItemResponse;
}

/**
 * 从「礼物 + 收礼人 + 留言」直接组装下单请求。action 层用它，避免把抓包字段
 * （`map_ext` / `aid` / `business_type`）暴露给 OneBot 客户端。
 *
 * 这是 **组合**而不复制逻辑：`itemSubId` 与 `itemList` 仍然由
 * {@link buildGiftMallBuyItemRequest} 生成，只是把缺省值收敛到一处。
 */
export function buildGiftMallSendRequest(options: {
  gift: Pick<GiftMallGift, 'giftId' | 'giftPrice' | 'svipDiscount'>;
  senderUin: number;
  toUin: number;
  message?: string;
  /** 直发填充时间；不给就用当前时间。 */
  sendDate?: string;
  needAnonymous?: boolean;
  /** 赠送渠道标记，抓包里是 0。 */
  freeSendType?: number;
  /** 下单渠道 id；抓包里是空串。 */
  aid?: string;
  businessType?: number;
  mapExt?: Record<string, string>;
  timestampMs?: number;
  buyNum?: number;
}): GiftMallBuyItemRequest {
  const now = options.timestampMs ?? Date.now();
  const sendDate = options.sendDate ?? new Date(now).toISOString().slice(0, 10);
  const buyOptions: GiftMallBuyItemOptions = {
    aid: options.aid ?? '',
    businessType: options.businessType ?? 0,
    gift: options.gift,
    senderUin: options.senderUin,
    toUin: options.toUin,
    message: options.message ?? '',
    sendDate,
    needAnonymous: options.needAnonymous ?? false,
    freeSendType: options.freeSendType ?? 0,
    mapExt: options.mapExt ?? {},
    timestampMs: now,
    ...(options.buyNum === undefined ? {} : { buyNum: options.buyNum }),
  };
  return buildGiftMallBuyItemRequest(buyOptions);
}
