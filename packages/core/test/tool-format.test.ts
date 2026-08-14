// SPDX-License-Identifier: AGPL-3.0-only
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

  it("prefers node-computed detail over the input heuristic (Codex apply_patch → edit)", () => {
    // Bare, `apply_patch` isn't recognized as an edit by the name heuristic…
    const bare = formatTool("apply_patch", { changes: { "src/x.ts": {} } });
    expect(bare.verb).not.toBe("Edited");
    // …but the node's detail makes it render as a proper edit with a diff.
    const f = formatTool("apply_patch", { changes: {} }, { kind: "edit", path: "src/x.ts", oldText: "a", newText: "b" });
    expect(f.verb).toBe("Edited");
    expect(f.path).toBe("src/x.ts");
    expect(f.target).toBe("x.ts");
    expect(f.diffs).toHaveLength(1);
    expect(f.added).toBe(1);
    expect(f.removed).toBe(1);
  });

  it("renders a shell detail as a command even when input lacks a known key", () => {
    const f = formatTool("local_shell", { argv_hidden: true }, { kind: "shell", command: "git status" });
    expect(f.verb).toBe("Ran");
    expect(f.glyph).toBe("terminal");
    expect(f.command).toBe("git status");
    expect(f.title).toBe("Bash");
  });

  it("does not let detail override an agent-output stream", () => {
    const f = formatTool("agent_output", { stream: "stderr", output: "x" }, { kind: "shell", command: "nope" });
    expect(f.verb).toBe("Agent output");
    expect(f.command).toBeUndefined();
  });

  it("renders a delegation detail with the delegated role and its own glyph", () => {
    const f = formatTool("Task", { subagent_type: "Explore" }, { kind: "delegation", label: "Explore", description: "find the auth flow" });
    expect(f.verb).toBe("Delegated");
    expect(f.glyph).toBe("agent");
    expect(f.title).toBe("Delegated → Explore");
    expect(f.target).toBe("Explore");
    expect(f.query).toBe("find the auth flow");
  });

  it("renders a delegation with no named role as a plain Delegated card", () => {
    const f = formatTool("dispatch_agent", {}, { kind: "delegation", description: "audit the diff" });
    expect(f.verb).toBe("Delegated");
    expect(f.title).toBe("Delegated");
    expect(f.query).toBe("audit the diff");
  });
});

describe("tool-result outcome (exitCode / isError / truncated)", () => {
  it("marks a shell call that exited non-zero as an error and carries the exit code", () => {
    const f = formatTool("bash", { command: "false" }, { kind: "shell", command: "false", result: { exitCode: 1 } });
    expect(f.isError).toBe(true);
    expect(f.exitCode).toBe(1);
  });

  it("marks an agent-reported error even with a zero/absent exit code", () => {
    const f = formatTool("read", { path: "/x" }, { kind: "read", path: "/x", result: { isError: true } });
    expect(f.isError).toBe(true);
  });

  it("does not flag a successful call, but still surfaces a truncated result", () => {
    const ok = formatTool("bash", { command: "ls" }, { kind: "shell", command: "ls", result: { exitCode: 0 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.exitCode).toBe(0);
    const trunc = formatTool("bash", { command: "ls" }, { kind: "shell", command: "ls", result: { exitCode: 0, truncated: true } });
    expect(trunc.isError).toBeFalsy();
    expect(trunc.truncated).toBe(true);
  });
});

describe("toolGroupSummary", () => {
  it("appends a failure count when any call errored", () => {
    const s = toolGroupSummary([
      { name: "bash", input: { command: "make" }, detail: { kind: "shell", command: "make", result: { exitCode: 0 } } },
      { name: "bash", input: { command: "test" }, detail: { kind: "shell", command: "test", result: { exitCode: 2 } } },
    ]);
    expect(s).toBe("Ran 2 commands · 1 failed");
  });

  it("counts reads, runs, and edits into a phrase", () => {
    const s = toolGroupSummary([
      { name: "Read", input: { path: "a" } },
      { name: "Read", input: { path: "b" } },
      { name: "Bash", input: { command: "ls" } },
      { name: "Edit", input: { path: "c", old_string: "x", new_string: "y" } },
    ]);
    expect(s).toBe("Read 2 files, ran a command, edited a file");
  });

  it("counts delegated tasks as their own phrase", () => {
    const s = toolGroupSummary([
      { name: "Read", input: { path: "a" } },
      { name: "Task", input: {}, detail: { kind: "delegation", label: "Explore" } },
      { name: "Task", input: {}, detail: { kind: "delegation", label: "Plan" } },
    ]);
    expect(s).toBe("Read a file, delegated 2 tasks");
  });
});
