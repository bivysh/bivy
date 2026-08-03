// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("agent picker separates recommended agents and exposes protection", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('className="picker-section-label">Recommended');
  expect(source).toContain('className="picker-section-label">More agents');
  expect(source).toContain("runtime.protectionLevel");
  expect(source).toContain("Runs with your OS user permissions and no Bivy-owned isolation");
});

test("full computer access requires an informed second action", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('t.id === "danger-full-access"');
  expect(source).toContain("Confirm full computer access");
  expect(source).toContain("Bivy is not an isolation boundary");
});

test("provider key save awaits an authoritative acknowledgement", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/ProviderConnect.tsx", import.meta.url), "utf8");
  expect(source).toContain("await controller.saveApiKey");
  expect(source).toContain('role="alert"');
  expect(source).not.toContain("setTimeout(() => {\n              controller.listProviders()");
});

test("global attention count reaches title and installed app badge", async () => {
  const source = await readFile(new URL("../../packages/web/src/App.tsx", import.meta.url), "utf8");
  expect(source).toContain('document.title = count > 0 ? `(${count}) Bivy` : "Bivy"');
  expect(source).toContain("setAppBadge?.(count)");
  expect(source).toContain("clearAppBadge?.()");
});

test("failed ephemeral machines are retained only by explicit debug build opt-in", async () => {
  const source = await readFile(new URL("../../packages/web/src/flags.ts", import.meta.url), "utf8");
  expect(source).toContain('VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1"');
  expect(source).not.toContain("EPHEMERAL_KEEP_FAILED_MACHINES = true");
});
