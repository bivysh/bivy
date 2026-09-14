// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("machine, session, and run presence use the canonical StatusDot", async () => {
  for (const path of [
    "App.tsx",
    "components/NodeSwitcher.tsx",
    "components/ConnectRunner.tsx",
    "components/RunPill.tsx",
    "components/RunDetails.tsx",
    "components/WebSpeechRecorder.tsx",
  ]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<StatusDot");
    expect(source, path).not.toMatch(/(?:node|session|run|attn|voice-listening)-dot|mark-badge/);
  }
  const sessions = await readFile(new URL("components/SessionList.tsx", ROOT), "utf8");
  const sourceMarks = await readFile(new URL("components/SourceMark.tsx", ROOT), "utf8");
  expect(sessions).toContain("<SourceMark");
  expect(sourceMarks).toContain("<StatusDot");
  const queue = await readFile(new URL("components/GithubQueue.tsx", ROOT), "utf8");
  expect(queue).toContain("<RowMark");
  expect(queue).not.toMatch(/(?:node|session|run|attn|voice-listening)-dot|mark-badge/);
});

test("canonical status dots expose every documented state", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".status-dot {");
  for (const status of ["unseen", "online", "working", "needs-action", "failed", "saved"]) {
    expect(css).toContain(`.status-dot[data-status="${status}"]`);
  }
  expect(css).not.toMatch(/\.(?:node|session|run|attn|voice-listening)-dot|\.mark-badge/);
});
