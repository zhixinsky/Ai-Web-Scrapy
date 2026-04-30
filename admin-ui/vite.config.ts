import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /** 避免 cropperjs 等 CJS 依赖预构建哈希过期后出现 504 Outdated Optimize Dep */
  optimizeDeps: {
    include: ['cropperjs'],
  },
  server: {
    /** 绑定 IPv4，避免仅监听 ::1 时浏览器访问 localhost 解析到 127.0.0.1 无法连接 */
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3780',
        changeOrigin: true,
      },
    },
  },
});
