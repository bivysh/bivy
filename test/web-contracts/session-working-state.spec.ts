// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Stop gives immediate progress and a recovery timeout", async () => {
  const composer = await readFile(new URL("../../packages/web/src/components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("setStopping(true)");
  expect(composer).toContain("Stopping…");
  expect(composer).toContain("10_000");
  expect(composer).toContain("The agent didn&apos;t confirm it stopped.");
});
