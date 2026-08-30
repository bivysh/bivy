// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeInfo, SandboxTier } from "@bivy/core";

/** Sandbox tiers (Codex's vocabulary), shared by the node default (Settings) and
 *  the per-session/draft pickers. Lives in its own module so the composer can
 *  import it without pulling the whole Settings overlay into the initial chunk. */
export const SANDBOX_TIERS: Array<{ id: SandboxTier; label: string; hint: string }> = [
  { id: "read-only", label: "Read-only", hint: "Read the workspace; no writes, no network." },
  { id: "workspace-write", label: "Workspace write", hint: "Read and write inside the workspace." },
  { id: "danger-full-access", label: "Full access", hint: "No in-agent sandbox — the agent can do anything (opt-out)." },
];

/** Whether this runtime can enforce a protection tier instead of merely
 * forwarding it as a preference. Native sandboxes enforce boundaries directly;
 * intercepted or MCP tools can stop an escape and ask the user. */
export function runtimeEnforcesProtection(runtime: RuntimeInfo | undefined): boolean {
  if (!runtime) return true;
  const caps = (runtime.capabilities || {}) as Record<string, unknown>;
  return runtime.protectionLevel === "native-sandbox"
    || caps.toolInterception === true
    || caps.mcpToolApprovals === true;
}
