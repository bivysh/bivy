// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("Delegate this Session creates a Run targeting the exact encrypted Session context", async () => {
  const [menu, controller] = await Promise.all([
    read("../../packages/web/src/components/SessionMenu.tsx"),
    read("../../packages/web/src/store/controller.ts"),
  ]);
  expect(menu).toContain("Delegate this Session…");
  expect(menu).toContain("controller.delegateSession(sessionId, instruction)");
  expect(menu).toContain("openRun(result.runId)");
  expect(controller).toContain("async delegateSession(sessionId: string, instruction: string)");
  expect(controller).toContain("templateCiphertext: `${TEMPLATE_PREFIX}:${nodeId}:${encrypted}`");
  expect(controller).toContain('targetKind: "existing_session"');
  expect(controller).toContain("targetSessionId: sessionId");
  expect(controller).toContain("const run = await runAutomationNow(this.local, created.id)");
});

test("a delegated Run resumes or fails visibly and never cold-starts without context", async () => {
  const server = await read("../../src/server.ts");
  expect(server).toContain('resumeOnMissing: item.source === "schedule" || item.targetKind === "existing_session"');
  expect(server).toContain("the session is not available on this Machine");
  expect(server).toContain("await waitForSessionIdle(record)");
  expect(server).toContain("if (record.worktree && !opts?.isMessage)");
});
