import { defineConfig } from '@playwright/test';

/**
 * The product in Docker, hosted both ways (shared and dedicated), with customers'
 * extensions delivered by the pipeline. Needs a running Docker; builds images, so
 * the first run takes several minutes.  pnpm e2e:docker
 */
export default defineConfig({
  testDir: './docker',
  workers: 1,
  fullyParallel: false,
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1360, height: 900 } },
});
