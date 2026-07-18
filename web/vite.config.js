import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      '/api': 'http://localhost:4587',
      '/oauth': 'http://localhost:4587',
    },
  },
});
