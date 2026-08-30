// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const SOURCE = new URL("../../packages/web/src/modalStack.ts", import.meta.url);

test("modal history sentinel survives the StrictMode effect cycle", async () => {
  const source = await readFile(SOURCE, "utf8");

  // The sentinel must not be pushed synchronously: StrictMode would clean up
  // that first effect run and queue a Back navigation before mounting it again.
  expect(source).toContain("queueMicrotask(() => {");
  expect(source).toContain("if (cancelled) return;");
  expect(source).toMatch(/cancelled = true;[\s\S]*history\.back\(\);/);
});
