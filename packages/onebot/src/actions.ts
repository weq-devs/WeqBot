/**
 * OneBot v11 action 注册表。
 *
 * 设计要点（与 SnowLuma 的 `action-kit` 同思路，但**不搬代码**）：
 *   - action 只声明**入参形状 + 执行函数**，参数校验和错误信封由适配层统一做；
 *   - 执行函数的依赖（协议客户端、会话）在注册时注入，不在 action 内部取全局；
 *   - 未注册的 action 返回 OneBot 的错误码，而不是抛异常穿透到 WS。
 */

import { WeqBotError } from '@weqbot/common';

export interface ActionContext {
  /** 当前账号 uin。 */
  selfUin: string;
  /** 调试用：本次请求的 echo。 */
  echo?: string;
}

export interface ActionDefinition<Params = Record<string, unknown>, Result = unknown> {
  /** OneBot action 名，如 `send_group_msg`。 */
  name: string;
  /** 文档用的简述（生成的 action 列表会被 WebUI / SDK 读到）。 */
  summary?: string;
  run(params: Params, context: ActionContext): Promise<Result>;
}

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition<never, unknown>>();

  register<Params, Result>(definition: ActionDefinition<Params, Result>): this {
    if (this.actions.has(definition.name)) {
      throw new WeqBotError('UNKNOWN', `action 重复注册：${definition.name}`);
    }
    this.actions.set(definition.name, definition as ActionDefinition<never, unknown>);
    return this;
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  list(): Array<{ name: string; summary?: string }> {
    return [...this.actions.values()].map(({ name, summary }) => ({
      name,
      ...(summary ? { summary } : {}),
    }));
  }

  async call(
    name: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<unknown> {
    const action = this.actions.get(name);
    if (!action) {
      // OneBot 约定：未知 action 用 1404。
      throw new WeqBotError('UNKNOWN', `不支持的 action：${name}`, { fields: { retcode: 1404 } });
    }
    return action.run(params as never, context);
  }
}
