// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("browser-node convergence preserves an offline key rotation", async () => {
  const controller = await read("../../packages/web/src/store/coordinators/credentials-models-coordinator.ts");
  expect(controller).toContain("acceptedIncoming");
  expect(controller).toContain("remoteAt > localAt");
  expect(controller).toContain("deletedAt[recordId]");
  expect(controller).toContain("record.kind !== \"api_key\"");
  expect(controller).not.toContain('if (this.direct || this.store.getState().status !== "online")');
});
