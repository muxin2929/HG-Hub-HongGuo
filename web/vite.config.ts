import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期把接口/图片/媒体全部打到本地网关（gateway/app.py，默认 8080）。
// 生产由 Caddy/Nginx 把 /api /img /media 反代到同一个网关，前端代码无需改动。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/img': 'http://127.0.0.1:8080',
      '/media': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 1200,
  },
});
