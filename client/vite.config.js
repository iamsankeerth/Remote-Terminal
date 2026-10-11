import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built client is served by the native Node server from client/dist, which also serves the
// API and the WebSocket on the same origin.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
});
