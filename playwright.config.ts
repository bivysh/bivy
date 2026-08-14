import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
