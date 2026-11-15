import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * WebUI 是纯静态 SPA：开发期由 vite 起本地服务；构建产物（`dist/`）由
 * `@weqbot/node` 的 WebUI 服务托管。
 *
 * 开发服务器只听 127.0.0.1，与正式服务的默认一致，不把页面暴露到局域网。
 *
 * `/api` 代理到控制台服务（默认 6099）：开发期与正式部署走同一套 cookie 语义，
 * 前端代码不需要为「跨端口」写任何特例。后端没起时页面会显示「无法连接」。
 * 想脱离后端看界面：`VITE_WEBUI_MOCK=1 pnpm dev:webui`。
 *
 * 代理会把 `Host` 与 `Origin` 都改写成后端地址 —— 控制台对两者都做校验
 * （防 DNS rebinding + 跨站写），开发服务器自己的 `127.0.0.1:5173` 会被拒。
 * 生产端的安全逻辑一点没放宽：这里改的是**发出去的请求头**。
 */
const target = process.env.WEQBOT_WEBUI_ORIGIN ?? 'http://127.0.0.1:6099';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest) => {
            // 写请求的 Origin 必须与 Host 同源，否则后端 403。
            proxyRequest.setHeader('origin', new URL(target).origin);
          });
        },
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022' },
});
