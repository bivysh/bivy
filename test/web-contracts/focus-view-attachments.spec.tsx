// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import type { TranscriptEntry } from "@bivy/core";
import { focusEntries } from "../../packages/web/src/focusTranscript.js";

const image = { kind: "image" as const, name: "result.png", size: 42, mimeType: "image/png", hash: "a".repeat(64) };

test("Focus view carries an earlier attachment onto the final answer", () => {
  const entries: TranscriptEntry[] = [
    { id: "user", role: "user", text: "Show me" },
    { id: "commentary", role: "assistant", text: "I’ll attach it.", attachments: [image] },
    { id: "tool", role: "assistant", text: "", tool: { callId: "attach", name: "shell", input: {}, status: "done" } },
    { id: "final", role: "assistant", text: "Attached." },
  ];

  const focused = focusEntries(entries, false);

  expect(focused.map((entry) => entry.id)).toEqual(["user", "final"]);
  expect(focused[1]?.attachments).toEqual([image]);
});

test("Focus view retains an attachment-only assistant turn", () => {
  const entries: TranscriptEntry[] = [
    { id: "user", role: "user", text: "Show me" },
    { id: "attachment", role: "assistant", text: "", attachments: [image] },
  ];

  expect(focusEntries(entries, false)[1]).toMatchObject({ id: "attachment", attachments: [image] });
});

test("Focus view does not duplicate an attachment already grouped on the final answer", () => {
  const entries: TranscriptEntry[] = [
    { id: "user", role: "user", text: "Show me" },
    { id: "attachment", role: "assistant", text: "", attachments: [image] },
    { id: "final", role: "assistant", text: "Attached.", attachments: [image] },
  ];

  expect(focusEntries(entries, false)[1]?.attachments).toEqual([image]);
});

test("Focus view hides in-progress prose without hiding emitted attachments", () => {
  const entries: TranscriptEntry[] = [
    { id: "user", role: "user", text: "Show me" },
    { id: "working", role: "assistant", text: "Interim narration", streaming: true, attachments: [image] },
  ];

  expect(focusEntries(entries, true)[1]).toMatchObject({ id: "working", text: "", streaming: false, attachments: [image] });
});
