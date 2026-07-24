// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import { diffOps, compactDiffOps, editHunks, formatTool, toolGroupSummary } from "../src/tool-format.js";

describe("diffOps", () => {
  it("marks added, removed, and context lines", () => {
    const ops = diffOps("a\nb\nc", "a\nB\nc");
    expect(ops).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("treats a new file as all additions", () => {
    const ops = diffOps("", "x\ny");
    expect(ops.filter((o) => o.type === "add")).toHaveLength(2);
    expect(ops.some((o) => o.type === "del")).toBe(false);
  });
});

describe("compactDiffOps", () => {
  it("collapses long unchanged runs into a skip", () => {
    const ctx = Array.from({ length: 20 }, (_, i) => ({ type: "ctx" as const, text: `line ${i}` }));
    const ops = [{ type: "add" as const, text: "new" }, ...ctx, { type: "del" as const, text: "old" }];
    const out = compactDiffOps(ops);
    const skip = out.find((o) => o.type === "skip");
    expect(skip).toBeTruthy();
    expect(skip && skip.type === "skip" && skip.count).toBe(14);
  });

  it("leaves short runs intact", () => {
    const ops = diffOps("a\nb\nc", "a\nb\nc");
    expect(compactDiffOps(ops)).toHaveLength(3);
  });
});

describe("editHunks", () => {
  it("reads a single old_string/new_string pair", () => {
    const hunks = editHunks({ old_string: "foo\nbar", new_string: "foo\nbaz" });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.added).toBe(1);
    expect(hunks[0]!.removed).toBe(1);
  });

  it("reads an array of edits", () => {
    const hunks = editHunks({ edits: [{ oldText: "a", newText: "b" }, { oldText: "", newText: "c" }] });
    expect(hunks).toHaveLength(2);
  });
});

describe("formatTool", () => {
  it("classifies a bash command", () => {
    const f = formatTool("Bash", { command: "ls -la" });
    expect(f.verb).toBe("Ran");
    expect(f.glyph).toBe("terminal");
    expect(f.command).toBe("ls -la");
    expect(f.title).toBe("Bash");
  });

  it("builds a diff for a Write as a new file", () => {
    const f = formatTool("Write", { path: "/a/b/c.ts", content: "line1\nline2" });
    expect(f.verb).toBe("Created");
    expect(f.target).toBe("c.ts");
    expect(f.diffs).toHaveLength(1);
    expect(f.added).toBe(2);
  });

  it("summarizes an edit's changed lines", () => {
    const f = formatTool("Edit", { path: "x.ts", old_string: "a\nb", new_string: "a\nB" });
    expect(f.verb).toBe("Edited");
    expect(f.added).toBe(1);
    expect(f.removed).toBe(1);
  });

  it("labels agent stderr streams as normal agent output", () => {
    const f = formatTool("agent_output", { stream: "stderr", output: "working on it" });
    expect(f.verb).toBe("Agent output");
    expect(f.title).toBe("Agent output");
    expect(f.output).toBe("working on it");
  });
});

describe("toolGroupSummary", () => {
  it("counts reads, runs, and edits into a phrase", () => {
    const s = toolGroupSummary([
      { name: "Read", input: { path: "a" } },
      { name: "Read", input: { path: "b" } },
      { name: "Bash", input: { command: "ls" } },
      { name: "Edit", input: { path: "c", old_string: "x", new_string: "y" } },
    ]);
    expect(s).toBe("Read 2 files, ran a command, edited a file");
  });
});
