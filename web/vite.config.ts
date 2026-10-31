import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Express server (port 8787) handles login and proxies Launch27.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:8787',
      '/l27': 'http://localhost:8787',
      '/api': 'http://localhost:8787',
    },
  },
});
