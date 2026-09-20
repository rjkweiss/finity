import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          p5: ['p5', 'react-p5'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    name: 'client',
  },
});
