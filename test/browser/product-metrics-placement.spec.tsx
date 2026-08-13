// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("remote and Receipt milestones are emitted only at concrete customer actions", async () => {
  const [transport, controller, app] = await Promise.all([
    read("../../packages/core/src/transport-relay.ts"),
    read("../../packages/web/src/store/controller.ts"),
    read("../../packages/web/src/App.tsx"),
  ]);
  expect(transport).toContain("this.hasReachedNode && !socket._productReconnectReported");
  expect(transport).toContain('event: "remote_reconnect"');
  expect(controller).toContain('recordProductMetric(this.local, "remote_intervention"');
  expect(app).toContain('recordProductMetric(controller.local, "receipt_reviewed"');
  for (const source of [transport, controller, app]) {
    expect(source).not.toContain('event: "remote_reconnect", sessionId');
    expect(source).not.toContain('"remote_intervention", id');
    expect(source).not.toContain('"receipt_reviewed", runId');
  }
});
