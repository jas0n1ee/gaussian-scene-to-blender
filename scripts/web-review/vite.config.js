import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: path.resolve('index.html'),
        'render-after': path.resolve('render-after.html'),
      },
    },
  },
});
