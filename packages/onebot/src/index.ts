/**
 * `@weqbot/onebot` —— OneBot v11 适配层。
 *
 * 职责边界：
 *   - **事件**：`BotEvent` → OneBot post 格式（`message` / `notice` / `request` / `meta_event`）；
 *   - **动作**：OneBot action → `@weqbot/protocol` 调用；
 *   - **网络**：WS 正向 / 反向、HTTP（P4 落地，依赖 `ws`）；
 *   - **状态**：`message_id` 映射、群/好友缓存。
 *
 * 不负责：协议细节（`@weqbot/protocol`）、登录上线（`@weqbot/session`）。
 *
 * 可搬运参考：`WeQ/packages/bot/src/adapter/onebot.ts`（现成的 WS 客户端 + echo 关联），
 * 以及 SnowLuma 的 `packages/onebot`（action-kit / 事件转换 / message store 分离）。
 * **不要**照搬 SnowLuma 的 native websocket 实现 —— 我们用 `ws`，纯 JS。
 *
 * TODO(P4)：`createOneBotAdapter(config, deps)` 落地前，这里只有注册表与 id 映射。
 */

export {
  ActionRegistry,
  type ActionContext,
  type ActionDefinition,
} from './actions';
export { MessageIdMap, type MessageIdEntry, type MessageIdMapOptions } from './message-id';
