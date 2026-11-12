/**
 * `@weqbot/bot` —— 门面层。
 *
 * **WeQ 嵌入时只应该依赖这个包**（以及它拉进来的纯 TS 依赖）。它不 import
 * `@weqbot/node`，因此打包产物里不会出现第二份 `.node`。
 *
 * 独立进程的入口在 `@weqbot/node`。
 */

export { createBot, describeBot, type Bot, type CreateBotOptions } from './createBot';
export { generateSecToken } from './sec-token';
export type {
  BotConfig,
  OneBotConfig,
  OneBotHttpConfig,
  OneBotWsClientConfig,
  OneBotWsServerConfig,
} from './config';
