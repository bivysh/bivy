// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("machine refresh precedes the list and install instructions", async () => {
  const view = await readFile(new URL("../../packages/web/src/components/ConnectRunner.tsx", import.meta.url), "utf8");
  const refresh = view.indexOf('className="connect-waiting"');
  const list = view.indexOf('className="connect-nodes"');
  const install = view.indexOf('className="connect-options"');
  expect(refresh).toBeGreaterThan(-1);
  expect(refresh).toBeLessThan(list);
  expect(list).toBeLessThan(install);
});
