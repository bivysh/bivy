// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, it, expect } from "vitest";
import { approvalSeverity, formatApproval } from "../src/approval-format.js";

describe("approvalSeverity", () => {
  it("flags network/external actions as high", () => {
    expect(approvalSeverity({ tool: "bash", input: { command: "curl https://example.com" } })).toBe("high");
  });

  it("flags a routine file write as medium", () => {
    expect(approvalSeverity({ tool: "write", input: { path: "a.ts", content: "x" } })).toBe("medium");
  });

  it("defaults to low for a read-only-looking tool", () => {
    expect(approvalSeverity({ tool: "read", input: { path: "a.ts" } })).toBe("low");
  });
});

describe("formatApproval", () => {
  it("never allows remembering a critical (destructive) approval", () => {
    // Regression: the React ApprovalCard used to always show "Always allow",
    // even for a destructive action legacy explicitly hides that option for.
    const f = formatApproval({ tool: "bash", input: { command: "rm -rf /" } });
    expect(f.severity).toBe("critical");
    expect(f.canRemember).toBe(false);
  });

  it("allows remembering a non-critical approval", () => {
    const f = formatApproval({ tool: "write", input: { path: "a.ts" } });
    expect(f.canRemember).toBe(true);
  });

  it("surfaces the actual shell command for a bash/shell tool", () => {
    const f = formatApproval({ tool: "bash", input: { command: "ls -la" } });
    expect(f.command).toBe("ls -la");
  });
});
