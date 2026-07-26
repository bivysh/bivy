// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  defaultExecutionPolicy,
  evaluateChangedFiles,
  evaluatePolicyOutcome,
  isBranchAllowed,
  isModelAllowed,
  isRepoAllowed,
  isRuntimeAllowed,
  matchGlob,
  mergeExecutionPolicy,
  parseExecutionPolicy,
  sandboxTierMeetsFloor,
  strictestApprovalMode,
  strictestSandboxTier,
  approvalModeMeetsFloor,
  EXECUTION_POLICY_VERSION,
} from "../src/execution-policy.js";

describe("defaultExecutionPolicy / parseExecutionPolicy", () => {
  it("is fully permissive with no restrictions", () => {
    const policy = defaultExecutionPolicy();
    expect(policy.version).toBe(EXECUTION_POLICY_VERSION);
    expect(policy.allowedRuntimes).toBeUndefined();
    expect(policy.allowedModels).toBeUndefined();
    expect(policy.requireCleanCommit).toBe(false);
    expect(policy.requirePr).toBe(false);
    expect(policy.networkAllowed).toBe(true);
    expect(policy.mcpAllowed).toBe(true);
  });

  it("treats absence (existing GitHub-queue automations) as safe defaults, not an error", () => {
    const { policy, errors } = parseExecutionPolicy(undefined);
    expect(errors).toEqual([]);
    expect(policy).toEqual(defaultExecutionPolicy());
  });

  it("parses a fully-specified policy", () => {
    const { policy, errors } = parseExecutionPolicy({
      version: 1,
      allowedRuntimes: ["claude-code", "codex"],
      allowedModels: ["claude-sonnet-4-5"],
      requiredSandboxTier: "workspace-write",
      requiredApprovalMode: "risky",
      maxDurationMs: 600_000,
      allowedRepos: ["bivysh/*"],
      allowedBranches: ["issue-*"],
      networkAllowed: false,
      mcpAllowed: false,
      requiredChecks: [{ id: "test", command: "npm test", timeoutMs: 60_000 }],
      requireCleanCommit: true,
      requirePr: true,
      changedFiles: { allow: ["src/**"], deny: ["**/*.env"] },
    });
    expect(errors).toEqual([]);
    expect(policy.allowedRuntimes).toEqual(["claude-code", "codex"]);
    expect(policy.requiredSandboxTier).toBe("workspace-write");
    expect(policy.requiredChecks).toEqual([{ id: "test", command: "npm test", timeoutMs: 60_000 }]);
    expect(policy.changedFiles).toEqual({ allow: ["src/**"], deny: ["**/*.env"] });
  });

  it("drops invalid fields and reports them, falling back to safe defaults for each", () => {
    const { policy, errors } = parseExecutionPolicy({
      requiredSandboxTier: "sudo-mode",
      requiredApprovalMode: "yolo",
      allowedRuntimes: "claude-code", // not an array
      maxDurationMs: -5,
      requiredChecks: [{ id: "", command: "npm test" }, { id: "lint", command: "" }, { id: "ok", command: "npm run lint" }],
      networkAllowed: "yes",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(policy.requiredSandboxTier).toBeUndefined();
    expect(policy.requiredApprovalMode).toBeUndefined();
    expect(policy.allowedRuntimes).toBeUndefined();
    expect(policy.maxDurationMs).toBeUndefined();
    expect(policy.requiredChecks).toEqual([{ id: "ok", command: "npm run lint" }]);
    expect(policy.networkAllowed).toBe(true); // invalid -> falls back to the permissive default
  });

  it("rejects a policy version newer than this build understands, using defaults", () => {
    const { policy, errors } = parseExecutionPolicy({ version: 99, requirePr: true });
    expect(errors.length).toBe(1);
    expect(policy).toEqual(defaultExecutionPolicy());
  });

  it("treats a non-object policy as garbage, not a crash", () => {
    const { policy, errors } = parseExecutionPolicy("not a policy");
    expect(errors.length).toBe(1);
    expect(policy).toEqual(defaultExecutionPolicy());
  });
});

describe("mergeExecutionPolicy", () => {
  it("overrides only fields present on the patch", () => {
    const base = defaultExecutionPolicy();
    const merged = mergeExecutionPolicy(base, { requirePr: true, allowedRuntimes: ["codex"] });
    expect(merged.requirePr).toBe(true);
    expect(merged.allowedRuntimes).toEqual(["codex"]);
    expect(merged.requireCleanCommit).toBe(base.requireCleanCommit);
  });

  it("is a no-op with no patch", () => {
    const base = defaultExecutionPolicy();
    expect(mergeExecutionPolicy(base, undefined)).toBe(base);
  });
});

describe("sandbox tier floor", () => {
  it("read-only is the strictest, danger-full-access the least", () => {
    expect(sandboxTierMeetsFloor("read-only", "workspace-write")).toBe(true);
    expect(sandboxTierMeetsFloor("workspace-write", "read-only")).toBe(false);
    expect(sandboxTierMeetsFloor("danger-full-access", "workspace-write")).toBe(false);
  });

  it("strictestSandboxTier clamps UP, never down", () => {
    expect(strictestSandboxTier("danger-full-access", "read-only")).toBe("read-only");
    expect(strictestSandboxTier("read-only", "danger-full-access")).toBe("read-only");
    expect(strictestSandboxTier("workspace-write", undefined)).toBe("workspace-write");
  });

  it("no floor means anything satisfies it", () => {
    expect(sandboxTierMeetsFloor("danger-full-access", undefined)).toBe(true);
  });
});

describe("approval mode floor", () => {
  it("ranks never < autonomous < risky < always", () => {
    expect(approvalModeMeetsFloor("never", "autonomous")).toBe(false);
    expect(approvalModeMeetsFloor("autonomous", "risky")).toBe(false);
    expect(approvalModeMeetsFloor("risky", "always")).toBe(false);
    expect(approvalModeMeetsFloor("always", "risky")).toBe(true);
  });

  it("strictestApprovalMode clamps UP, never down", () => {
    expect(strictestApprovalMode("never", "always")).toBe("always");
    expect(strictestApprovalMode("always", "never")).toBe("always");
  });
});

describe("matchGlob", () => {
  it("matches literal paths", () => {
    expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/index.ts", "src/other.ts")).toBe(false);
  });

  it("* matches within a single path segment", () => {
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/nested/index.ts")).toBe(false);
  });

  it("** matches across path segments", () => {
    expect(matchGlob("src/**/*.ts", "src/a/b/index.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("**/*.env", "deep/nested/.env")).toBe(true);
  });

  it("escapes regex-special characters in literal segments", () => {
    expect(matchGlob("a.b+c", "a.b+c")).toBe(true);
    expect(matchGlob("a.b+c", "axbyc")).toBe(false);
  });
});

describe("evaluateChangedFiles", () => {
  it("passes with no globs configured", () => {
    expect(evaluateChangedFiles(defaultExecutionPolicy(), ["src/a.ts", "README.md"])).toEqual({ ok: true, violations: [] });
  });

  it("flags files matching a deny glob", () => {
    const policy = { ...defaultExecutionPolicy(), changedFiles: { deny: ["**/*.env", "secrets/**"] } };
    const result = evaluateChangedFiles(policy, ["src/a.ts", ".env", "secrets/keys.json"]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([".env", "secrets/keys.json"]);
  });

  it("flags files that don't match any allow glob", () => {
    const policy = { ...defaultExecutionPolicy(), changedFiles: { allow: ["src/**"] } };
    const result = evaluateChangedFiles(policy, ["src/a.ts", "docs/readme.md"]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["docs/readme.md"]);
  });

  it("deny wins over allow for the same file", () => {
    const policy = { ...defaultExecutionPolicy(), changedFiles: { allow: ["**"], deny: ["**/*.env"] } };
    const result = evaluateChangedFiles(policy, [".env"]);
    expect(result.ok).toBe(false);
  });
});

describe("allowlist predicates", () => {
  it("isRuntimeAllowed/isModelAllowed default to unrestricted", () => {
    const policy = defaultExecutionPolicy();
    expect(isRuntimeAllowed(policy, "claude-code")).toBe(true);
    expect(isModelAllowed(policy, "anything")).toBe(true);
  });

  it("isRuntimeAllowed enforces the allowlist", () => {
    const policy = { ...defaultExecutionPolicy(), allowedRuntimes: ["codex"] };
    expect(isRuntimeAllowed(policy, "codex")).toBe(true);
    expect(isRuntimeAllowed(policy, "claude-code")).toBe(false);
  });

  it("isModelAllowed enforces the allowlist only when a model was requested", () => {
    const policy = { ...defaultExecutionPolicy(), allowedModels: ["claude-sonnet-4-5"] };
    expect(isModelAllowed(policy, undefined)).toBe(true);
    expect(isModelAllowed(policy, "claude-sonnet-4-5")).toBe(true);
    expect(isModelAllowed(policy, "gpt-5")).toBe(false);
  });

  it("isRepoAllowed/isBranchAllowed support globs", () => {
    const policy = { ...defaultExecutionPolicy(), allowedRepos: ["bivysh/*"], allowedBranches: ["bivy/issue-*"] };
    expect(isRepoAllowed(policy, "bivysh/bivy")).toBe(true);
    expect(isRepoAllowed(policy, "other/repo")).toBe(false);
    expect(isBranchAllowed(policy, "bivy/issue-155")).toBe(true);
    expect(isBranchAllowed(policy, "main")).toBe(false);
  });
});

describe("evaluatePolicyOutcome", () => {
  it("succeeds only with no violations at all", () => {
    expect(evaluatePolicyOutcome({ hardViolations: [], softViolations: [] })).toBe("succeeded");
  });

  it("a hard violation always fails, even alongside soft ones", () => {
    expect(evaluatePolicyOutcome({ hardViolations: ["forbidden runtime"], softViolations: ["no PR"] })).toBe("failed");
  });

  it("a soft-only violation needs attention, never succeeds", () => {
    expect(evaluatePolicyOutcome({ hardViolations: [], softViolations: ["no PR"] })).toBe("needs_attention");
  });
});
