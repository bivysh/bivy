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
  "**/library.spec.ts",
  "**/share-landing.spec.ts",
];

// Specs whose layout, touch targets or visual baselines differ on a phone.
// Everything else asserts behavior that the desktop viewport already covers.
const mobileSpecs = [
  "**/agent-instructions.spec.ts",
  "**/browser-first-setup.spec.ts",
  "**/preview-drawing.spec.ts",
  "**/preview-reviewer.spec.ts",
  "**/preview-peek.spec.ts",
  "**/screenshots.spec.ts",
  "**/self-host-onboarding.spec.ts",
  "**/app-badge.spec.ts",
  "**/fresh-composer-layout.spec.ts",
  "**/changes-card.spec.tsx",
  "**/activity-history.spec.ts",
  "**/run-pill-apps.spec.ts",
  "**/review-card.spec.ts",
  "**/notify-offer.spec.ts",
  "**/followup-new-session.spec.ts",
];

// Mobile-specific specs whose mobile run does everything the desktop run does
// (plus touch-target, drawer or layout checks); desktop would only repeat it.
const mobileOnlySpecs = [
  "**/self-host-onboarding.spec.ts",
  "**/app-badge.spec.ts",
  "**/changes-card.spec.tsx",
  "**/run-pill-apps.spec.ts",
  "**/review-card.spec.ts",
  "**/notify-offer.spec.ts",
];

export default defineConfig({
  testDir: "./test/browser",
  // Pre-bundle the app's dependencies once so workers share a warm Vite cache
  // instead of racing to build one. See test/browser/global-setup.ts.
  globalSetup: "./test/browser/global-setup.ts",
  // Reuse each file's Vite server instead of duplicating cold transforms across
  // workers. Independent files still execute in parallel.
  // Public-repository Linux runners have four vCPUs; Playwright's default
  // uses only half of them.
  workers: process.env.CI ? "100%" : undefined,
  // Spread a file's tests across workers, so --shard balances by test rather
  // than by file and one long file no longer sets a shard's wall clock. Each
  // worker keeps its own dev server (fixtures.ts), and every test already gets
  // a fresh browser context. A file whose tests share state opts back into
  // serial mode with test.describe.configure.
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
  },
  projects: [
    { name: "behavior", testMatch: singleViewport, use: { viewport: { width: 1280, height: 800 } } },
    { name: "desktop", testIgnore: [...singleViewport, ...mobileOnlySpecs], use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", testMatch: mobileSpecs, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
