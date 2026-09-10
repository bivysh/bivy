// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("product milestones are emitted only at concrete customer actions", async () => {
  const [transport, controller, app, automations] = await Promise.all([
    read("../../packages/core/src/transport-relay.ts"),
    read("../../packages/web/src/store/controller.ts"),
    read("../../packages/web/src/App.tsx"),
    read("../../packages/web/src/components/AutomationsView.tsx"),
  ]);
  expect(transport).toContain("this.hasReachedNode && !socket._productReconnectReported");
  expect(transport).toContain('event: "remote_reconnect"');
  expect(controller).toContain('recordProductMetric(this.local, "remote_intervention"');
  expect(app).toContain('recordProductMetric(controller.local, "receipt_reviewed"');
  expect(controller).toContain('this.recordProductMilestone("activation_ready", true)');
  expect(controller).toContain('this.recordProductMilestone("first_useful_response", true)');
  expect(controller).toContain('if (event.type === "session.history") return;');
  expect(controller).toContain('this.recordProductMilestone("run_accepted")');
  expect(automations).toContain('controller.recordProductMilestone("run_accepted")');
  expect(controller).toContain('localStorage.setItem(key, "1")');
  for (const source of [transport, controller, app, automations]) {
    expect(source).not.toContain('event: "remote_reconnect", sessionId');
    expect(source).not.toContain('"remote_intervention", id');
    expect(source).not.toContain('"receipt_reviewed", runId');
    expect(source).not.toContain('"run_accepted", run.id');
    expect(source).not.toContain('"first_useful_response", sessionId');
  }
});
