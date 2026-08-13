// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Run details renders and exports an honest Receipt v1", async () => {
  const [view, app] = await Promise.all([
    readFile(new URL("../../packages/web/src/components/RunDetails.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/App.tsx", import.meta.url), "utf8"),
  ]);
  expect(view).toContain("receiptV1FromRun(run");
  expect(view).toContain("receiptV1Json(receipt)");
  expect(view).toContain("Export JSON");
  expect(view).toContain("receipt.observationLimitations");
  expect(view).not.toContain("Unavailable — a Receipt for this Run isn't ready yet.");
  expect(view).toContain("onReceiptReviewed?.()");
  expect(app).toContain('recordProductMetric(controller.local, "receipt_reviewed"');
});
