import assert from "node:assert/strict";
import { sandboxTier, sandboxArgsFor, claudePermissionModeFor, codexSandboxPolicy } from "../src/harness/sandbox.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.BIVY_SANDBOX;
  if (value === undefined) delete process.env.BIVY_SANDBOX;
  else process.env.BIVY_SANDBOX = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.BIVY_SANDBOX;
    else process.env.BIVY_SANDBOX = prev;
  }
}

check("default tier is workspace-write", () => {
  withEnv(undefined, () => assert.equal(sandboxTier(), "workspace-write"));
});

check("BIVY_SANDBOX selects the tier (with underscore normalization)", () => {
  withEnv("read-only", () => assert.equal(sandboxTier(), "read-only"));
  withEnv("read_only", () => assert.equal(sandboxTier(), "read-only"));
  withEnv("danger-full-access", () => assert.equal(sandboxTier(), "danger-full-access"));
  withEnv("nonsense", () => assert.equal(sandboxTier(), "workspace-write"));
});

check("codex maps tier to --sandbox <tier>", () => {
  assert.deepEqual(sandboxArgsFor("codex", "read-only"), ["--sandbox", "read-only"]);
  assert.deepEqual(sandboxArgsFor("codex", "workspace-write"), ["--sandbox", "workspace-write"]);
  assert.deepEqual(sandboxArgsFor("codex", "danger-full-access"), ["--sandbox", "danger-full-access"]);
});

check("gemini maps tier to --approval-mode", () => {
  assert.deepEqual(sandboxArgsFor("gemini", "read-only"), ["--approval-mode", "plan"]);
  assert.deepEqual(sandboxArgsFor("gemini", "workspace-write"), ["--approval-mode", "auto_edit"]);
  assert.deepEqual(sandboxArgsFor("gemini", "danger-full-access"), ["--approval-mode", "yolo"]);
});

check("agents without a native sandbox return no flags", () => {
  assert.deepEqual(sandboxArgsFor("goose", "read-only"), []);
  assert.deepEqual(sandboxArgsFor("opencode", "workspace-write"), []);
  assert.deepEqual(sandboxArgsFor("aider", "read-only"), []);
});

check("claude permissionMode mapping", () => {
  assert.equal(claudePermissionModeFor("read-only"), "plan");
  assert.equal(claudePermissionModeFor("workspace-write"), "default");
  assert.equal(claudePermissionModeFor("danger-full-access"), "bypassPermissions");
});

check("codex app-server sandbox policy threads the tier (allow-all disables the jail)", () => {
  // The tier IS Codex's --sandbox mode; the restrictive tiers keep escalating
  // every action to Bivy's approval cards ("untrusted").
  assert.deepEqual(codexSandboxPolicy("read-only"), { sandbox: "read-only", approvalPolicy: "untrusted" });
  assert.deepEqual(codexSandboxPolicy("workspace-write"), { sandbox: "workspace-write", approvalPolicy: "untrusted" });
  // "Full access" is an explicit opt-out: no sandbox AND never ask — otherwise
  // "allow all" would still gate every action behind a card (the bug this fixes).
  assert.deepEqual(codexSandboxPolicy("danger-full-access"), { sandbox: "danger-full-access", approvalPolicy: "never" });
});

if (failures > 0) { console.error(`\n${failures} sandbox test(s) failed`); process.exit(1); }
console.log("\nall sandbox tests passed");
