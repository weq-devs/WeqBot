/**
 * 页面唯一的 API 入口。
 *
 * 后端（`@weqbot/node` 的 WebUI 服务）还没有，现在整套是 mock；后端落地后在这里换成
 * HTTP 实现（契约见 `types.ts`），页面代码不动。
 */

import { mockApi } from './mock';
import type { Api } from './types';

export const api: Api = mockApi;

export type * from './types';
