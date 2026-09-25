// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("full computer access requires an informed second action", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('t.id === "danger-full-access"');
  expect(source).toContain("Confirm full computer access");
  expect(source).toContain("Bivy is not an isolation boundary");
});

test("legacy queue URLs redirect to the Runs destination", async () => {
  const source = await readFile(new URL("../../packages/web/src/router.ts", import.meta.url), "utf8");
  expect(source).toContain('if (v === "queue") return "runs";');
  expect(source).toContain('readonly AutomationsSection[] = ["runs", "rulesets"]');
});

test("opening the queue panel cannot trigger billable provisioning", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/GithubQueue.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("launchEphemeralQueueWorker(");
  expect(source).toContain("maybeAutoProvision policy owns launch/dedupe/rate-cap/teardown");
});

test("interactive billable runners disclose cost and teardown before selection", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Ephemeral.tsx", import.meta.url), "utf8");
  expect(source).toContain('title="Use this billable machine profile?"');
  expect(source).toContain("ephemeralCostHint");
  expect(source).toContain("controller.pickDraftEphemeralRunner(pendingRunner)");
});

test("failed ephemeral machines are retained only by explicit debug build opt-in", async () => {
  const source = await readFile(new URL("../../packages/web/src/flags.ts", import.meta.url), "utf8");
  expect(source).toContain('VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1"');
  expect(source).not.toContain("EPHEMERAL_KEEP_FAILED_MACHINES = true");
});
