// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — exec sandbox (configure the agent's own sandbox).
//
// Several agents ship their OWN sandbox, so Bivy just selects the right tier per
// session from one policy knob and lets each agent enforce it natively. This gives
// real, in-agent enforcement (a read-only session physically refuses writes) with
// a single data mapping and no OS-specific code. Agents without a native sandbox
// run under the filesystem, MCP, and network governance channels instead.
//
// Tiers use Codex's vocabulary because it's the clearest:
//   read-only          — may read the workspace; no writes, no network.
//   workspace-write    — may read/write the worktree; escapes need approval.
//   danger-full-access — no in-agent limit (explicit opt-out).
//
// Chosen by BIVY_SANDBOX (default workspace-write — the safe, useful middle).
// Agents without a native sandbox (Goose, OpenCode, Aider) return no flags and
// remain governed by the filesystem, MCP, and network channels instead.

export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

const TIERS: SandboxTier[] = ["read-only", "workspace-write", "danger-full-access"];

/** Coerce an arbitrary value to a valid SandboxTier, or undefined if it isn't one. */
export function normalizeSandboxTier(value: unknown): SandboxTier | undefined {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  return (TIERS as string[]).includes(raw) ? (raw as SandboxTier) : undefined;
}

// The node's configured default tier (from settings.json), set on startup and
// whenever node settings change. `BIVY_SANDBOX` still wins so an explicit env on
// the process overrides the persisted setting; a per-session override (passed to
// sandboxTier) wins over both.
let configuredTier: SandboxTier | undefined;
export function setConfiguredSandboxTier(value: unknown): void {
  configuredTier = normalizeSandboxTier(value);
}

/**
 * The sandbox tier to launch an agent at. Precedence:
 *   per-session override (arg) > BIVY_SANDBOX env > node setting > workspace-write.
 */
export function sandboxTier(override?: unknown): SandboxTier {
  return (
    normalizeSandboxTier(override) ??
    normalizeSandboxTier(process.env.BIVY_SANDBOX) ??
    configuredTier ??
    "workspace-write"
  );
}

/** Gemini expresses containment through --approval-mode rather than a tier flag. */
function geminiApprovalArgs(tier: SandboxTier): string[] {
  switch (tier) {
    case "read-only":
      return ["--approval-mode", "plan"]; // plan mode = read-only
    case "danger-full-access":
      return ["--approval-mode", "yolo"]; // auto-approve everything
    case "workspace-write":
    default:
      return ["--approval-mode", "auto_edit"]; // auto-approve edits, still bounded
  }
}

/**
 * Native sandbox/approval flags for an agent at a tier. Empty when the agent has
 * no native sandbox. These are inserted by the runtime when composing the
 * launch args (see AGENT_PROFILES.nativeSandbox).
 */
export function sandboxArgsFor(agentId: string, tier: SandboxTier): string[] {
  switch (agentId) {
    case "codex":
      return ["--sandbox", tier];
    // Qwen Code is a Gemini-CLI fork and shares its `--approval-mode` flag.
    case "gemini":
    case "qwen":
      return geminiApprovalArgs(tier);
    default:
      return [];
  }
}

/** Claude Agent SDK permissionMode equivalent of a tier (used by the SDK adapter). */
export function claudePermissionModeFor(tier: SandboxTier): "plan" | "default" | "bypassPermissions" {
  if (tier === "read-only") return "plan";
  if (tier === "danger-full-access") return "bypassPermissions";
  return "default"; // guardian's canUseTool still gates risky tools
}

/**
 * Codex app-server containment for a tier (the governed "Codex approvals"
 * runtime, whose shim drives `codex app-server`). Codex's `thread/start` takes
 * two knobs: `sandbox` (its native OS jail — the tier values ARE Codex's
 * `--sandbox` modes) and `approvalPolicy` (whether it escalates a proposed
 * action before running it). The restrictive tiers stay on "untrusted" so every
 * command/patch surfaces as a Bivy Approve/Deny card through the guardian, on
 * top of the sandbox. "Full access" (danger-full-access) is an explicit opt-out:
 * no sandbox AND "never" ask, so the agent runs unrestricted — otherwise
 * "allow all" would still gate every action behind an approval card, which is
 * exactly the mismatch this fixes.
 */
export function codexSandboxPolicy(tier: SandboxTier): { sandbox: SandboxTier; approvalPolicy: "untrusted" | "never" } {
  return tier === "danger-full-access"
    ? { sandbox: tier, approvalPolicy: "never" }
    : { sandbox: tier, approvalPolicy: "untrusted" };
}
