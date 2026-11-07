import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18081',
    channel: 'chrome',
    headless: true,
    locale: 'zh-CN',
  },
  projects: [
    { name: 'app', testMatch: '**/p1.spec.ts', use: { baseURL: 'http://127.0.0.1:18081' } },
    { name: 'process', testMatch: '**/process.spec.ts' },
    { name: 'features', testMatch: '**/features.spec.ts', use: { baseURL: 'http://127.0.0.1:18081' } },
    { name: 'history-bundle', testMatch: '**/history-bundle.spec.ts', use: { baseURL: 'http://127.0.0.1:18081' } },
    { name: 'export-failure', testMatch: '**/export-failure.spec.ts' },
    { name: 'boundary', testMatch: '**/boundary.spec.ts', use: { baseURL: 'http://127.0.0.1:18081' } },
    { name: 'faults', testMatch: '**/faults.spec.ts' },
  ],
  webServer: {
    command: 'node start-test-server.mjs',
    url: 'http://127.0.0.1:18081',
    reuseExistingServer: false,
  },
});
