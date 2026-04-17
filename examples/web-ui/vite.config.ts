import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/messages': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
