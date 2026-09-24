import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  // Shard individual cases, not whole files: large light/dark scenario matrices
  // otherwise pin an entire runner while other shards finish early. Explicit
  // serial suites still stay together. Bound workers on shared CI runners.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
  },
  projects: [
    // Source-contract checks need neither Chromium nor duplicate viewports.
    { name: "contracts", testDir: "./test/web-contracts" },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
