/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The engine is used from source in dev and bundled into the build.
  resolve: {
    alias: {
      '@fb/engine': path.resolve(__dirname, '../../packages/engine/src'),
      // The UI kit ported from Sangam (shadcn on Radix).
      '@ui': path.resolve(__dirname, 'src/ui'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    maxWorkers: 4,
  },
});
