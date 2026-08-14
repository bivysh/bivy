// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the composer starts a Run from one message without turning the Session into a Run", async () => {
  const [composer, sheet, controller, menu] = await Promise.all([
    read("../../packages/web/src/components/Composer.tsx"),
    read("../../packages/web/src/components/RunTaskSheet.tsx"),
    read("../../packages/web/src/store/controller.ts"),
    read("../../packages/web/src/components/SessionMenu.tsx"),
  ]);
  expect(composer).toContain('className="split-send"');
  expect(composer).toContain("Start a Run");
  expect(composer).toContain("Schedule for later");
  expect(sheet).toContain("You can continue to follow and steer the Session");
  expect(controller).toContain("async startRun(");
  expect(controller).toContain('targetKind: sessionId ? "existing_session" : "new_session"');
  expect(controller).toContain("targetSessionId: sessionId");
  expect(menu).not.toContain("Delegate this Session");
});

test("a Run targeting an existing Session resumes or fails visibly and never cold-starts without context", async () => {
  const server = await read("../../src/server.ts");
  expect(server).toContain('resumeOnMissing: item.source === "schedule" || item.targetKind === "existing_session"');
  expect(server).toContain("the session is not available on this Machine");
  expect(server).toContain("await waitForSessionIdle(record)");
  expect(server).toContain("if (record.worktree && !opts?.isMessage)");
});
