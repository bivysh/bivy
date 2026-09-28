// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Setup is ready when the machine, agent, credentials and workspace are ready.
// Sending a message and receiving a reply are separate from setup.

/** The distinct readiness checks, in the order they must resolve. Each depends on
 *  every earlier one, so a downstream check stays pending until its prerequisites
 *  pass — a credential can't be validated on a Machine that is not online.
 *
 *  `account_signed_in` is resolved eagerly by every caller (never left
 *  "checking") — in hosted mode the sign-in screen already gates all
 *  rendering before this model ever runs, and direct/self-host mode has no
 *  account concept at all. It exists so the model names the setup
 *  journey (sign-in, machine, provider, agent, workspace) for state-model
 *  tests and funnel metrics, not to duplicate that screen's own gating. */
export type ActivationCheckId =
  | "account_signed_in"
  | "machine_online"
  | "agent_installed"
  | "credential_valid"
  | "repository_ready";

export type ActivationCheckState = "pending" | "checking" | "passed" | "failed" | "unavailable";

/** A concrete, wired next action. Every failed check maps to exactly one — no
 *  inert buttons: a client only renders a remediation it can actually perform. */
export type ActivationRemediationKind =
  | "sign_in"
  | "connect_machine"
  | "install_agent"
  | "authenticate_credential"
  | "grant_repository";

export interface ActivationRemediation {
  kind: ActivationRemediationKind;
  label: string;
}

export interface ActivationCheck {
  id: ActivationCheckId;
  label: string;
  state: ActivationCheckState;
  /** Bounded, customer-readable status line (why it's blocked, what passed). */
  detail?: string;
  /** Present only on a failed check: the single tested remediation for it. */
  remediation?: ActivationRemediation;
}

export type ActivationStage = "not_started" | "in_progress" | "blocked" | "activated";

export interface Activation {
  checks: ActivationCheck[];
  stage: ActivationStage;
  /** All setup checks passed; the user can send their first message. */
  activated: boolean;
  /** The first failed check, when the sequence is blocked. */
  blockingCheckId?: ActivationCheckId;
  /** The single next action to resolve the first incomplete setup check. */
  nextAction?: ActivationRemediation & { checkId: ActivationCheckId };
}

/** Each signal is a tri-state: `true` passed, `false` failed with a remediation,
 *  and `undefined` = not yet determined (still checking / pending). Keeping them
 *  independent lets a client fill each in as its probe resolves. */
export interface ActivationSignals {
  /** The account is signed in (direct/self-host mode has no account, so this is
   *  always `true` there — see the `account_signed_in` doc comment above). */
  accountSignedIn?: boolean;
  /** The Machine is enrolled and currently reachable. */
  machineOnline?: boolean;
  /** A certified/supported agent (Claude Code / Codex) is installed and its
   *  capability has been verified — not merely present. An installed-but-
   *  unsupported/uncertified runtime does not satisfy this signal. */
  agentInstalled?: boolean;
  /** The model credential the agent needs is present and valid. */
  credentialValid?: boolean;
  /** The target repository is cloned/accessible on the Machine. */
  repositoryReady?: boolean;
}

interface CheckSpec {
  id: ActivationCheckId;
  label: string;
  signal: (s: ActivationSignals) => boolean | undefined;
  passed: string;
  checking: string;
  failed: string;
  remediation: ActivationRemediation;
}

const SPECS: readonly CheckSpec[] = [
  {
    id: "account_signed_in",
    label: "Signed in",
    signal: (s) => s.accountSignedIn,
    passed: "You're signed in.",
    checking: "Checking your sign-in…",
    failed: "You're not signed in yet.",
    remediation: { kind: "sign_in", label: "Sign in" },
  },
  {
    id: "machine_online",
    label: "Machine online",
    signal: (s) => s.machineOnline,
    passed: "Your Machine is connected.",
    checking: "Waiting for your Machine to come online…",
    failed: "Your Machine isn't reachable yet.",
    remediation: { kind: "connect_machine", label: "Connect a Machine" },
  },
  {
    id: "agent_installed",
    label: "Supported agent",
    signal: (s) => s.agentInstalled,
    passed: "A certified agent's capability is verified.",
    checking: "Verifying a supported agent's capability…",
    failed: "No certified, supported agent was found on the Machine.",
    remediation: { kind: "install_agent", label: "Install the agent" },
  },
  {
    id: "credential_valid",
    label: "Credential valid",
    signal: (s) => s.credentialValid,
    passed: "The model credential is valid.",
    checking: "Validating the model credential…",
    failed: "The model credential is missing or invalid.",
    remediation: { kind: "authenticate_credential", label: "Authenticate" },
  },
  {
    id: "repository_ready",
    label: "Workspace ready",
    signal: (s) => s.repositoryReady,
    passed: "Your workspace is ready on the Machine.",
    checking: "Checking your workspace…",
    failed: "The workspace isn't available to the agent.",
    remediation: { kind: "grant_repository", label: "Grant repository access" },
  },

];

/** Project the current signals into the ordered, distinct activation checks and
 *  the single next action. Sequential: the first unresolved check is `checking`,
 *  everything after an unresolved/blocking check stays `pending`, and a `false`
 *  signal blocks with its remediation. `activated` is true when all setup checks pass. */
export function deriveActivation(signals: ActivationSignals): Activation {
  const checks: ActivationCheck[] = [];
  let blockingCheckId: ActivationCheckId | undefined;
  let sawUnresolved = false;

  for (const spec of SPECS) {
    if (blockingCheckId || sawUnresolved) {
      // A prerequisite is failed or still resolving — this check can't run yet.
      checks.push({ id: spec.id, label: spec.label, state: "pending" });
      continue;
    }
    const value = spec.signal(signals);
    if (value === true) {
      checks.push({ id: spec.id, label: spec.label, state: "passed", detail: spec.passed });
    } else if (value === false) {
      blockingCheckId = spec.id;
      checks.push({ id: spec.id, label: spec.label, state: "failed", detail: spec.failed, remediation: spec.remediation });
    } else {
      sawUnresolved = true;
      checks.push({ id: spec.id, label: spec.label, state: "checking", detail: spec.checking });
    }
  }

  const activated = checks[checks.length - 1]?.state === "passed";
  const anyPassed = checks.some((c) => c.state === "passed");
  // Stage reflects how much is KNOWN: nothing resolved yet is not_started (even
  // though the first check is already probing), any pass is in_progress, a
  // failure is blocked, and all checks passed is activated.
  const stage: ActivationStage = activated
    ? "activated"
    : blockingCheckId
      ? "blocked"
      : anyPassed
        ? "in_progress"
        : "not_started";

  // The single next action. When blocked, it's the failing check's remediation.
  // Otherwise it is the first still-checking check's remediation.
  let nextAction: Activation["nextAction"];
  if (!activated) {
    const target = checks.find((c) => c.state === "failed") ?? checks.find((c) => c.state === "checking");
    const spec = target ? SPECS.find((s) => s.id === target.id) : undefined;
    if (target && spec) nextAction = { ...spec.remediation, checkId: target.id };
  }

  return {
    checks,
    stage,
    activated,
    ...(blockingCheckId ? { blockingCheckId } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

/** The minimal structural slice of the client `AppState` the activation adapter
 *  reads. Declared here (rather than importing `AppState`) so this module stays
 *  dependency-free and unit-testable with plain objects; the real `AppState`
 *  satisfies it structurally. */
export interface ActivationStateInput {
  /** Direct/self-host mode has no account concept — `account_signed_in`
   *  resolves `true` unconditionally when this is set. */
  direct: boolean;
  /** Hosted-mode sign-in state; ignored when `direct` is true. */
  signedIn: boolean;
  /** ConnectionStatus: "online" | "offline" | "connecting" | "reconnecting" | … */
  status: string;
  /** RuntimeInfo carries `status`/`supportTier` behind an index signature, so
   *  accept any record and read both defensively (an absent status means
   *  "available"; only `supportTier === "supported"` counts as certified). */
  runtimes: ReadonlyArray<Record<string, unknown>>;
  readiness: { credential: { ok: boolean }; repository: { ok: boolean } } | null;
}

/** Map the current client state to activation signals, then use
 *  {@link deriveActivation}. Every mapping is conservative and honest:
 *
 *  - a transient connection state (connecting/reconnecting) leaves
 *    `machineOnline` undefined (still checking) rather than failing;
 *  - `agentInstalled` requires a *certified, supported* runtime — an installed
 *    but experimental/beta/unverified one leaves the signal `false`, not `true`;
 */
export function activationFromState(state: ActivationStateInput): Activation {
  const accountSignedIn = state.direct ? true : state.signedIn;
  const machineOnline = state.status === "online" ? true : state.status === "offline" ? false : undefined;
  const agentInstalled = state.runtimes.length
    ? state.runtimes.some((r) => String(r.status ?? "available") === "available" && r.supportTier === "supported")
    : undefined;
  const credentialValid = state.readiness?.credential.ok;
  const repositoryReady = state.readiness?.repository.ok;
  return deriveActivation({ accountSignedIn, machineOnline, agentInstalled, credentialValid, repositoryReady });
}
