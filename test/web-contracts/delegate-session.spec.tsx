// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("a Run targeting an existing Session resumes or fails visibly and never cold-starts without context", async () => {
  const server = await read("../../src/server.ts");
  expect(server).toContain('resumeOnMissing: item.source === "schedule" || item.targetKind === "existing_session"');
  expect(server).toContain("the session is not available on this Machine");
  expect(server).toContain("await waitForSessionIdle(record)");
  expect(server).toContain("if (record.worktree && !opts?.isMessage)");
});
