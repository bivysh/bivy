// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("Local models presents discovery, verification, Machine ownership, and a start action", async () => {
  const settings = await read("../../packages/web/src/components/Settings.tsx");
  expect(settings).toContain("Discover on this Machine");
  expect(settings).toContain("never scans");
  expect(settings).toContain("Verify endpoint & list models");
  expect(settings).toContain("Import & use in new session");
  expect(settings).toContain("startWithModel");
  expect(settings).toContain("unavailable on this Machine");
  expect(settings).not.toContain("This endpoint is account-wide, not just this machine");
});

test("controller discovery and verification await node acknowledgements", async () => {
  const controller = await read("../../packages/web/src/store/controller.ts");
  expect(controller).toContain('this.awaitAck({ kind: "models.custom.discover" }, 10_000)');
  expect(controller).toContain('this.awaitAck({ kind: "models.custom.verify", baseUrl');
  expect(controller).toContain("return String(event.provider");
});
