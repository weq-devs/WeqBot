/**
 * `ws` 的导入适配。
 *
 * `ws` 是 CommonJS，导出形态随加载器变化：
 *   - 普通 ESM / tsx：默认导出是 WebSocket 构造函数，`WebSocketServer` 挂在它上面；
 *   - `node --test` 的 loader：默认导出丢了静态属性，但**命名空间导入是完整的**。
 * 所以统一走命名空间导入 —— 这是两条路径下都成立的唯一形态。
 */

import * as wsNamespace from 'ws';
import type { WebSocket as WsSocket, WebSocketServer as WsServerClass } from 'ws';

export type WsServer = WsServerClass;
export type { WsSocket };

export const WebSocket = wsNamespace.WebSocket as unknown as typeof WsSocket;
export const WebSocketServer = wsNamespace.WebSocketServer as unknown as typeof WsServerClass;

// 导出不可用时尽早炸，而不是等 `new` 的时候才炸。
if (typeof WebSocketServer !== 'function' || typeof WebSocket !== 'function') {
  throw new Error('ws 导出不可用（CommonJS 互操作问题），请检查加载器');
}
