import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
  },
});
