/**
 * OneBot action 注册表与分发。
 *
 * 与 SnowLuma 的 `action-kit` + `api-handler` 同思路（2026-11-13），但刻意精简：
 *   - 每个 action 声明 `params` 校验器 + `run(params, ctx)`；校验失败统一 1400，
 *     未注册统一 1404，业务失败 100；
 *   - **注册由后端能力决定**：后端没实现的 action 不注册，调用时返回 1404，
 *     而不是注册了再崩。这条对「WeqBot 协议还没覆盖」的 action 很重要；
 *   - 敏感能力（红包 / 转账 / 支付）**永不进这张表** —— 见文件末尾的 deny-list。
 */

import { NotImplementedError, type OneBotBackend } from './backend';
import { parseMessageSegments } from './message-parser';
import {
  RETCODE,
  failedResponse,
  okResponse,
  type ApiResponse,
  type JsonObject,
  type JsonValue,
  type MessageFormat,
} from './types';

export interface ActionContext {
  selfId: number;
  backend: OneBotBackend;
  messageFormat: MessageFormat;
  /** 适配器启动时刻（ms）；`get_status.time` 用它算运行秒数。 */
  startedAt: number;
  /** 分配给一条新发出消息的 OneBot message_id。 */
  internSentMessageId(params: {
    isGroup: boolean;
    targetId: number;
    sequence: number;
    clientSequence: number;
    random: number;
    timestamp: number;
  }): number;
  /** 按 OneBot message_id 反查撤回所需的定位信息。 */
  resolveMessageMeta(messageId: number): import('./backend').RecallTarget | null;
  /** 按 OneBot message_id 取完整事件快照（`get_msg`）。 */
  resolveMessageEvent(messageId: number): Record<string, unknown> | null;
  /**
   * 给服务端历史里的一条消息分配 OneBot message_id，并缓存事件快照。
   *
   * 历史分页把上一页的 `message_id` 当锚点传回来，所以这些消息也必须进
   * 同一张进程内有界表（`MessageStore` + `MessageIdMap`），否则第二页接不上。
   */
  internMessageEvent(
    params: {
      isGroup: boolean;
      targetId: number;
      sequence: number;
      /** 私聊的服务端 NT 序号。 */
      ntSequence?: number;
      wireId: string;
      random: number;
      timestamp: number;
    },
    event: Record<string, unknown>,
  ): number;
  /**
   * 本进程内该会话最新一条已观测消息的 seq；没有就返回 `null`。
   *
   * 历史 action 不传 `message_id` 时用它当锚点。它只读进程内已有的观测记录
   * （`MessageStore`），不新增任何落盘 / 索引（硬约束 13）。
   */
  findLatestMessageAnchor(isGroup: boolean, targetId: number): number | null;
}

/** 参数校验器：返回规范化后的值，或抛 `ParamError`。 */
export type ParamParser<T> = (raw: JsonObject) => T;

export class ParamError extends Error {}

export interface ActionDefinition<Params = JsonObject, Result = JsonValue> {
  name: string;
  summary?: string;
  /** 未提供时按 `{}` 处理。 */
  parse?: ParamParser<Params>;
  run(params: Params, ctx: ActionContext): Promise<Result>;
}

export interface ActionListEntry {
  name: string;
  summary?: string;
}

/**
 * 一条待装配的 action。
 *
 * `available` 是 P8 新增的能力谓词（按域分组的能力面用它），`requires` 是旧的
 * 扁平方法名清单；两者都给时以 `available` 为准。
 */
export interface ActionEntry {
  definition: ActionDefinition<never, never>;
  available?: (backend: import('./backend').OneBotBackend) => boolean;
  requires?: Array<keyof import('./backend').OneBotBackend>;
}

/**
 * 声明一条 action 并保留参数/返回类型推断。
 *
 * 直接写 `{ definition: {...}, available }` 会被 `ActionEntry` 的
 * `ActionDefinition<never, never>` 吸成 `never`，所以统一走这个 helper。
 */
export function defineAction<P, R>(
  definition: {
    name: string;
    summary?: string;
    parse?: ParamParser<P>;
    run(params: P, ctx: ActionContext): Promise<R>;
  },
  options: {
    available?: (backend: import('./backend').OneBotBackend) => boolean;
    requires?: Array<keyof import('./backend').OneBotBackend>;
  } = {},
): ActionEntry {
  return {
    definition: definition as unknown as ActionDefinition<never, never>,
    ...(options.available ? { available: options.available } : {}),
    ...(options.requires ? { requires: options.requires } : {}),
  };
}

// ─────────────────────────── 参数校验小工具 ───────────────────────────

export function requiredPositiveInt(raw: JsonObject, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ParamError(`${key} 必须是正整数`);
  }
  return value;
}

export function optionalPositiveInt(raw: JsonObject, key: string): number | undefined {
  if (raw[key] === undefined || raw[key] === '' || raw[key] === 0) return undefined;
  return requiredPositiveInt(raw, key);
}

export function requiredString(raw: JsonObject, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') throw new ParamError(`${key} 必须是字符串`);
  return value;
}

export function optionalString(raw: JsonObject, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ParamError(`${key} 必须是字符串`);
  return value;
}

export function optionalBool(raw: JsonObject, key: string, fallback = false): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new ParamError(`${key} 必须是布尔值`);
}

export function requiredInt(raw: JsonObject, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ParamError(`${key} 必须是整数`);
  }
  return value;
}

/** `message` 参数 → segment 数组；`auto_escape` 时整段当文本。 */
export function parseMessageParam(raw: JsonObject): {
  segments: import('./segments').Segment[];
  autoEscape: boolean;
} {
  const autoEscape = optionalBool(raw, 'auto_escape');
  const message = raw.message;
  if (message === undefined || message === null) throw new ParamError('message 不能为空');
  const segments = parseMessageSegments(message, autoEscape);
  if (segments.length === 0) throw new ParamError('message 不能为空');
  return { segments, autoEscape };
}

// ─────────────────────────── 注册表 ───────────────────────────

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition<never, JsonValue>>();

  register<Params, Result>(definition: ActionDefinition<Params, Result>): this {
    if (this.actions.has(definition.name)) {
      throw new Error(`action 重复注册：${definition.name}`);
    }
    this.actions.set(definition.name, definition as unknown as ActionDefinition<never, JsonValue>);
    return this;
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  list(): ActionListEntry[] {
    return [...this.actions.values()].map(({ name, summary }) => ({
      name,
      ...(summary ? { summary } : {}),
    }));
  }

  /**
   * 分发一次调用；所有错误都收敛成 OneBot 响应，不向外抛。
   *
   * `echo` 必须原样回传：OneBot v11 客户端靠它把响应和请求配对（v11 规范里
   * 它是响应信封的必选字段）。之前这里没有这个参数，`ws-server` 传进来的
   * echo 被静默丢弃 —— 严格按 echo 过滤的客户端会一直等，表现为「所有 action
   * 都超时」，但事件推送照常，非常难查。
   */
  async call(
    name: string,
    params: JsonObject | undefined,
    ctx: ActionContext,
    echo?: JsonValue,
  ): Promise<ApiResponse> {
    const definition = this.actions.get(name);
    if (!definition) {
      return withEcho(failedResponse(RETCODE.UNKNOWN_ACTION, `不支持的 action：${name}`), echo);
    }

    let parsed: unknown;
    try {
      parsed = definition.parse ? definition.parse((params ?? {}) as JsonObject) : (params ?? {});
    } catch (cause) {
      if (cause instanceof ParamError) {
        return withEcho(failedResponse(RETCODE.BAD_REQUEST, cause.message), echo);
      }
      throw cause;
    }

    try {
      const data = await definition.run(parsed as never, ctx);
      return withEcho(okResponse((data ?? null) as JsonValue), echo);
    } catch (cause) {
      if (cause instanceof NotImplementedError) {
        return withEcho(failedResponse(RETCODE.UNKNOWN_ACTION, cause.message), echo);
      }
      // 需要 `ctx` 才能判定的参数错误（例如 message_id 与会话不匹配）只能在 run 里
      // 抛；ParamError 的语义始终是 1400，不因抛出位置不同而变成业务失败。
      if (cause instanceof ParamError) {
        return withEcho(failedResponse(RETCODE.BAD_REQUEST, cause.message), echo);
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      return withEcho(failedResponse(RETCODE.ACTION_FAILED, message), echo);
    }
  }
}

/** echo 未传时不要凭空造一个 `undefined` 键 —— 序列化后客户端会看到 `"echo":null`。 */
function withEcho(response: ApiResponse, echo: JsonValue | undefined): ApiResponse {
  return echo === undefined ? response : { ...response, echo };
}

/**
 * 敏感能力 deny-list。
 *
 * 红包 / 转账 / 支付类命令**不注册到 OneBot**：它们极易被黑产拿去做资金相关
 * 的滥用。WeQ desktop 需要时走自己的通道（直接 `@weqbot/protocol` 或控制
 * 通道的 host-only 方法），不走 OneBot。
 *
 * 这里用测试兜底，而不是靠人记：`test/action-deny-list.test.ts` 会遍历注册表。
 */
export const DENIED_ACTIONS: readonly string[] = [
  'send_redbag',
  'send_red_packet',
  'receive_redbag',
  'grab_redbag',
  'transfer',
  'send_transfer',
  'hb_send',
  'sso_handle',
] as const;

/** action 名是否属于敏感能力（含前缀形式，如 `group_send_redbag`）。 */
export function isDeniedAction(name: string): boolean {
  const normalized = name.toLowerCase();
  return DENIED_ACTIONS.some(
    (denied) =>
      normalized === denied ||
      normalized.endsWith(`_${denied}`) ||
      normalized.startsWith(`${denied}_`),
  );
}
