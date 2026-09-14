// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("Run recovery actions lead to their specific working surfaces", async () => {
  const [detail, app] = await Promise.all([
    read("../../packages/web/src/components/RunDetails.tsx"),
    read("../../packages/web/src/App.tsx"),
  ]);
  expect(detail).toContain("Review failed checks");
  expect(detail).toContain("checksRef.current?.scrollIntoView");
  expect(detail).toContain("Review Session");
  expect(detail).toContain("onReauthenticate(reauthenticate.provider, run.machine?.id");
  expect(app).toContain("await controller.connectToNode(targetNode)");
  expect(app).toContain("setNeedsModelAuth({ nodeId: targetNode, provider, reason })");
  expect(app).not.toContain('openSettings("models")');
});
