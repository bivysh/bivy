// Probe the actual browser, not the package cache: Linux shared libraries live
// outside ~/.cache/ms-playwright and may differ between hosted runner images.
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>Chromium readiness</title>");
  if (await page.title() !== "Chromium readiness") throw new Error("Chromium readiness check failed");
} finally {
  await browser.close();
}
