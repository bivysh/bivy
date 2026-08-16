// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared preflight checklist. Pure: takes signals the CALLER already gathered
// (the CLI reads local files; control-plane queries its store) and turns them
// into a consistent set of checks with one severity/blocking policy, so
// config-as-code validate/test, the control-plane API, and the PWA Test event
// workflow report the same thing for the same signals instead of three
// independently-tuned notions of "this automation looks broken."
import type { PreflightCheckResult, PreflightGate, PreflightSignals } from "./types.js";

function check(id: PreflightCheckResult["id"], severity: PreflightCheckResult["severity"], label: string, detail: string, blocksSave = false): PreflightCheckResult {
  return { id, severity, label, detail, blocksSave };
}

function skipped(id: PreflightCheckResult["id"], label: string): PreflightCheckResult {
  return check(id, "skipped", label, "No signal was available to check this in the current context.");
}

export function runPreflightChecks(signals: PreflightSignals): PreflightCheckResult[] {
  const results: PreflightCheckResult[] = [];

  const src = signals.sourceConnection;
  if (!src) results.push(skipped("source_connection", "Source connection"));
  else if (!src.required) results.push(check("source_connection", "ok", "Source connection", src.detail ?? "This trigger does not need a connected source."));
  else if (src.connected) results.push(check("source_connection", "ok", "Source connection", src.detail ?? "The source is connected."));
  else results.push(check("source_connection", "warn", "Source connection", src.detail ?? "No source is connected yet; events will not reach this automation until you connect one."));

  const repo = signals.repoAccess;
  if (!repo) results.push(skipped("repo_access", "Repository access"));
  else if (!repo.required) results.push(check("repo_access", "ok", "Repository access", repo.detail ?? "No repository scope is required."));
  else if (repo.knownInstalled === true) results.push(check("repo_access", "ok", "Repository access", repo.detail ?? "The source is installed on the configured repositories."));
  else if (repo.knownInstalled === false) results.push(check("repo_access", "warn", "Repository access", repo.detail ?? `Not installed on ${repo.configuredRepos.join(", ") || "the configured repository"} yet.`));
  else results.push(check("repo_access", "info", "Repository access", repo.detail ?? "Repository access could not be confirmed from here."));

  const key = signals.encryptedKeyOwnership;
  if (!key) results.push(skipped("encrypted_key_ownership", "Encrypted instructions"));
  else if (!key.required) results.push(check("encrypted_key_ownership", "ok", "Encrypted instructions", key.detail ?? "This draft does not require encrypted instructions yet."));
  else if (!key.hasCiphertext) results.push(check("encrypted_key_ownership", "block", "Encrypted instructions", key.detail ?? "Instructions have not been encrypted for any machine yet — pair a machine and save again.", true));
  else if (key.ownerNodeOnline === false) results.push(check("encrypted_key_ownership", "warn", "Encrypted instructions", key.detail ?? "The machine that holds the decryption key is currently offline; runs will queue until it reconnects."));
  else results.push(check("encrypted_key_ownership", "ok", "Encrypted instructions", key.detail ?? "The assigned machine can decrypt these instructions."));

  const machine = signals.assignedMachine;
  if (!machine) results.push(skipped("assigned_machine", "Assigned machine"));
  else if (machine.capabilityGap?.length) {
    results.push(check("assigned_machine", "warn", "Assigned machine", machine.detail ?? `No machine has ever declared the required capability: ${machine.capabilityGap.join(", ")}. Runs will queue until one does.`));
  }
  else if (machine.primaryOnline) results.push(check("assigned_machine", "ok", "Assigned machine", machine.detail ?? "The assigned machine is online."));
  else if (machine.fallbackAvailable || machine.sharedQueueHasOnlineNode) results.push(check("assigned_machine", "warn", "Assigned machine", machine.detail ?? "The assigned machine is offline, but a fallback can pick up the work."));
  else results.push(check("assigned_machine", "warn", "Assigned machine", machine.detail ?? "No machine is currently online to run this — the automation will queue until one is."));

  const cred = signals.agentModelCredentials;
  if (!cred) results.push(skipped("agent_model_credentials", "Agent/model credentials"));
  else if (cred.ready === true) results.push(check("agent_model_credentials", "ok", "Agent/model credentials", cred.detail ?? "Credentials are ready."));
  else if (cred.ready === false && cred.explicit) results.push(check("agent_model_credentials", "block", "Agent/model credentials", cred.detail ?? `${cred.agent ?? "The requested agent"} has no ready credentials on the assigned machine.`, true));
  else if (cred.ready === false) results.push(check("agent_model_credentials", "warn", "Agent/model credentials", cred.detail ?? "The node default agent has no ready credentials right now."));
  else results.push(check("agent_model_credentials", "info", "Agent/model credentials", cred.detail ?? "Credential readiness could not be confirmed from here."));

  const sandbox = signals.sandboxPolicy;
  if (!sandbox) results.push(skipped("sandbox_policy", "Sandbox & policy"));
  else if (sandbox.unsafeCombo) results.push(check("sandbox_policy", "block", "Sandbox & policy", sandbox.detail ?? "autonomous approval with danger-full-access sandbox requires an explicit acknowledgement.", true));
  else if (sandbox.requestedApproval !== sandbox.effectiveApproval || sandbox.requestedSandbox !== sandbox.effectiveSandbox) {
    results.push(check("sandbox_policy", "info", "Sandbox & policy", sandbox.detail ?? `Restricted by policy to ${sandbox.effectiveSandbox} / ${sandbox.effectiveApproval}.`));
  } else results.push(check("sandbox_policy", "ok", "Sandbox & policy", sandbox.detail ?? "Requested sandbox and approval are within policy."));

  return results;
}

/** Reduce a checklist to a save decision: hard failures block, everything
 *  else that isn't clean requires the caller to collect an explicit
 *  acknowledgement before proceeding. */
export function gateFromChecks(results: PreflightCheckResult[]): PreflightGate {
  const blockingChecks = results.filter((r) => r.blocksSave);
  const warnChecks = results.filter((r) => !r.blocksSave && (r.severity === "warn" || r.severity === "block"));
  return {
    blocked: blockingChecks.length > 0,
    blockingChecks,
    requiresAck: blockingChecks.length === 0 && warnChecks.length > 0,
    warnChecks,
  };
}
