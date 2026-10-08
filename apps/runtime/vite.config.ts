/// <reference types="vitest/config" />
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The runtime renders forms with the studio's form code (one source for the
 * builder preview and live forms): `@form` and `@ui` point into apps/studio.
 * Shared libraries are de-duplicated so both sides use one React.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@fb/engine': path.resolve(__dirname, '../../packages/engine/src'),
      '@form': path.resolve(__dirname, '../studio/src/form'),
      '@ui': path.resolve(__dirname, '../studio/src/ui'),
    },
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false, maxWorkers: 4 },
});
