// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Run cancellation is confirmed and only offered for nonterminal durable Runs", async () => {
  const [automations, history, queue, detail] = await Promise.all([
    readFile(new URL("../../packages/web/src/components/AutomationsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/components/RunHistory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/components/GithubQueue.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/runDetail.ts", import.meta.url), "utf8"),
  ]);

  expect(detail).toContain('["succeeded", "failed", "cancelled", "done"]');
  expect(history).toContain('canonical.actions.some((action) => action.kind === "cancel")');
  expect(history).toContain("Cancelling…");
  expect(automations).toContain('title="Cancel Run?"');
  expect(automations).toContain("await controller.cancelAutomationRun(");
  expect(queue).toContain("!isTerminalRun(");
  expect(queue).toContain('title="Cancel Run?"');
  expect(queue).toContain("await controller.cancelAutomationRun(");
  expect(queue).toContain("Cancelling…");
});

test("controller waits for cancellation and refreshes both durable Run feeds", async () => {
  const source = await readFile(new URL("../../packages/web/src/store/coordinators/automations-account-coordinator.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async cancelAutomationRun"), source.indexOf("async startRun", source.indexOf("async cancelAutomationRun")));
  expect(method).toContain("await this.deps.api.cancelAutomationRun(this.deps.local, id)");
  expect(method).toContain("this.fetchAutomationRuns(50)");
  expect(method).toContain("this.fetchGithubQueue(30)");
  expect(method.indexOf("await this.deps.api.cancelAutomationRun")).toBeLessThan(method.indexOf("Promise.all"));
});
