import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/console': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/pay-api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Two pages: the console, and the payment page payers open from a link, with its own small bundle.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        pay: fileURLToPath(new URL('./pay.html', import.meta.url)),
      },
    },
  },
});
