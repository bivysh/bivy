// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// The agent-UX eval's scoring: what counts as using Bivy the way a task needed.
import assert from "node:assert/strict";
import test from "node:test";
import { countCardBlocks, scoreAgentUx, shownFiles } from "../src/certification/agent-ux.js";

test("each kind of expectation passes on what the agent did and fails on what it didn't", () => {
  const seen = { blocks: { bivy_notice: 1, bivy_attachment: 1 }, asked: false, approvals: ["apply_automations"], reply: "This session runs on Build-Box.", shown: ["/work/out/report.md"], files: ["scripts/hello.sh"] };
  const passed = (expect: Parameters<typeof scoreAgentUx>[0]) => scoreAgentUx(expect, seen, { machine: "build-box" }).map((check) => check.passed);
  assert.deepEqual(passed([{ block: "bivy_notice" }, { block: "bivy_attachment", min: 2 }]), [true, false]);
  assert.deepEqual(passed([{ asked: true }, { approval: "apply_automations" }]), [false, true]);
  assert.deepEqual(passed([{ reply: "{machine}" }]), [true], "placeholders fill, and case doesn't matter");
  assert.deepEqual(passed([{ shown: "report.md" }, { shown: "out/*.md" }, { shown: "notes.md" }]), [true, true, false], "a shown file matches by its trailing path");
  assert.deepEqual(passed([{ file: "scripts/*.sh" }, { file: "*.sh" }]), [true, false], "a glob doesn't cross directories");
});

test("chat cards are counted wherever they sit in the history", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "bivy_notice", notice: { id: "n", text: "x" } }] },
    { role: "assistant", content: [{ type: "bivy_attachment" }, { type: "bivy_attachment" }] },
  ];
  assert.deepEqual(countCardBlocks(messages), { bivy_notice: 1, bivy_attachment: 2 });
});


test("a file counts as shown by an attachment card, a ::view line or a markdown image", () => {
  const messages = [
    { role: "user", content: "::view{src=ignored.md}" },
    { role: "assistant", content: [{ type: "text", text: "Here:\n::view{src=report.md caption=\"Summary\"}\nand ![chart](./out/chart.png)" }] },
    { role: "assistant", content: [{ type: "bivy_attachment", ref: { name: "log.txt" } }] },
    { role: "assistant", content: "Mid-sentence ::view{src=no.md} is not a directive." },
  ];
  assert.deepEqual(shownFiles(messages), ["report.md", "./out/chart.png", "log.txt"]);
});
