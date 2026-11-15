/**
 * 页面唯一的 API 入口。
 *
 * 默认走真 HTTP（`@weqbot/node` 的控制台服务）。开发期想脱离后端看界面时，
 * 用 `VITE_WEBUI_MOCK=1 pnpm dev:webui` —— 那时整套换成 `mock.ts`，页面代码不变。
 */

import { httpApi } from './http';
import { mockApi } from './mock';
import type { Api } from './types';

export const usingMock = import.meta.env.VITE_WEBUI_MOCK === '1';

export const api: Api = usingMock ? mockApi : httpApi;

export type * from './types';
export { ApiError } from './types';
