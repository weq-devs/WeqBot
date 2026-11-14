import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * WebUI 是纯静态 SPA：开发期由 vite 起本地服务；构建产物（`dist/`）将由
 * `@weqbot/node` 的 WebUI 服务托管（TODO「P5 后端缺口 W1」）。
 *
 * 开发服务器只听 127.0.0.1，与正式服务的默认一致，不把页面暴露到局域网。
 */
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022' },
});
