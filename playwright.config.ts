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

// The merge queue runs only these core flows (PW_SMOKE=1, desktop viewport);
// nightly and release runs execute every spec on every viewport. Pick specs
// that span first run, chat, automation and update paths, not edge cases.
const smokeSpecs = [
  "**/screenshots.spec.ts",
  "**/browser-first-setup.spec.ts",
  "**/self-host-onboarding.spec.ts",
  "**/chat-follow.spec.ts",
  "**/run-details.spec.ts",
  "**/pwa-update.spec.ts",
  "**/automation-accounts.spec.ts",
];
const smoke = Boolean(process.env.PW_SMOKE);

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
    { name: "desktop", testIgnore: singleViewport, ...(smoke && { testMatch: smokeSpecs }), use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", testIgnore: singleViewport, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
