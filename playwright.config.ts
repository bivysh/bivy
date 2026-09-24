import { defineConfig } from "@playwright/test";

// Browser behavior that does not depend on viewport runs once. Attachment
// tests already exercise explicit narrow/wide viewports inside each case.
const singleViewport = [
  "**/cloud-chat-handoff.spec.ts",
  "**/machine-claim-selection.spec.ts",
  "**/api-isolation.spec.ts",
  "**/runtime-config.spec.ts",
  "**/chat-attachments.spec.ts",
  "**/pwa-lifecycle.spec.ts",
];

export default defineConfig({
  testDir: "./test/browser",
  // Reuse each file's Vite server instead of duplicating cold transforms across
  // workers. Independent files still execute in parallel.
  // Public-repository Linux runners have four vCPUs; Playwright's default
  // uses only half of them.
  workers: process.env.CI ? "100%" : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
  },
  projects: [
    // Source-contract checks need neither Chromium nor duplicate viewports.
    { name: "contracts", testDir: "./test/web-contracts" },
    { name: "behavior", testMatch: singleViewport, use: { viewport: { width: 1280, height: 800 } } },
    { name: "desktop", testIgnore: singleViewport, use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", testIgnore: singleViewport, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
