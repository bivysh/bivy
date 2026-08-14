// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The activation readiness model: one resumable setup sequence expressed as a
// pure, framework-agnostic projection over the current signals. It produces the
// distinct, ordered checks a customer sees — Machine online, agent installed,
// credential valid, repository ready, and finally a real agent answer — each with
// exactly one remediation when it fails.
//
// The load-bearing invariant lives here, not in any UI: setup is **activated**
// only when a real agent has answered. A green Machine/agent/credential/repo
// chain is "almost there", never "ready". This is the "never report setup
// success before a real agent response" rule, enforced as a property of the
// model so no client can accidentally claim a false-positive readiness.

/** The distinct readiness checks, in the order they must resolve. Each depends on
 *  every earlier one, so a downstream check stays pending until its prerequisites
 *  pass — a credential can't be validated on a Machine that is not online.
 *
 *  `account_signed_in` is resolved eagerly by every caller (never left
 *  "checking") — in hosted mode the sign-in screen already gates all
 *  rendering before this model ever runs, and direct/self-host mode has no
 *  account concept at all. It exists so the model names the full five-step
 *  journey (sign-in, machine, provider, agent, first response) for state-model
 *  tests and funnel metrics, not to duplicate that screen's own gating. */
export type ActivationCheckId =
  | "account_signed_in"
  | "machine_online"
  | "agent_installed"
  | "credential_valid"
  | "repository_ready"
  | "agent_answered";

export type ActivationCheckState = "pending" | "checking" | "passed" | "failed" | "unavailable";

/** A concrete, wired next action. Every failed check maps to exactly one — no
 *  inert buttons: a client only renders a remediation it can actually perform. */
export type ActivationRemediationKind =
  | "sign_in"
  | "connect_machine"
  | "install_agent"
  | "authenticate_credential"
  | "grant_repository"
  | "run_starter_task";

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
  /** True ONLY when the `agent_answered` check has passed — a real agent response
   *  is the sole evidence of readiness. Never derived from the upstream chain. */
  activated: boolean;
  /** The first failed check, when the sequence is blocked. */
  blockingCheckId?: ActivationCheckId;
  /** The single next action to move activation forward: the blocking check's
   *  remediation, or running the starter task once the chain is otherwise green. */
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
  /** A real agent response was observed for the starter task. This alone proves
   *  readiness; it is never inferred from the four signals above. */
  agentAnswered?: boolean;
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
    label: "Repository ready",
    signal: (s) => s.repositoryReady,
    passed: "Your repository is ready on the Machine.",
    checking: "Preparing your repository…",
    failed: "The repository isn't available to the agent.",
    remediation: { kind: "grant_repository", label: "Grant repository access" },
  },
  {
    id: "agent_answered",
    label: "Agent answered",
    signal: (s) => s.agentAnswered,
    passed: "The agent answered — you're ready to run.",
    checking: "Waiting for the agent to answer the starter task…",
    failed: "The starter task didn't get an agent response.",
    remediation: { kind: "run_starter_task", label: "Run the starter task" },
  },
];

/** Project the current signals into the ordered, distinct activation checks and
 *  the single next action. Sequential: the first unresolved check is `checking`,
 *  everything after an unresolved/blocking check stays `pending`, and a `false`
 *  signal blocks with its remediation. `activated` is true only when the final
 *  agent-answered check passes. */
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
  // failure is blocked, and only a real agent answer is activated.
  const stage: ActivationStage = activated
    ? "activated"
    : blockingCheckId
      ? "blocked"
      : anyPassed
        ? "in_progress"
        : "not_started";

  // The single next action. When blocked, it's the failing check's remediation.
  // Otherwise it's the first still-`checking` check's remediation (e.g. "run the
  // starter task" once the chain is green but the agent hasn't answered yet).
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
  providers: ReadonlyArray<{ configured?: boolean; expiresAt?: number }>;
  reposAuthed: boolean;
  transcript: ReadonlyArray<{ role: string; text: string; tool?: unknown }>;
}

/** Map the current client state to activation signals, then use
 *  {@link deriveActivation}. Every mapping is conservative and honest:
 *
 *  - a transient connection state (connecting/reconnecting) leaves
 *    `machineOnline` undefined (still checking) rather than failing;
 *  - `agentInstalled` requires a *certified, supported* runtime — an installed
 *    but experimental/beta/unverified one leaves the signal `false`, not `true`;
 *  - `agentAnswered` is set ONLY by a real assistant message with text in the
 *    transcript — never by an installed agent or an online Machine. A turn that
 *    has not answered yet stays "checking", surfacing "run the starter task" as
 *    the next action, so the UI can never claim readiness before a real response.
 */
export function activationFromState(state: ActivationStateInput, now: number = Date.now()): Activation {
  const accountSignedIn = state.direct ? true : state.signedIn;
  const machineOnline = state.status === "online" ? true : state.status === "offline" ? false : undefined;
  const agentInstalled = state.runtimes.length
    ? state.runtimes.some((r) => String(r.status ?? "available") === "available" && r.supportTier === "supported")
    : undefined;
  const credentialValid = state.providers.length
    ? state.providers.some((p) => p.configured === true && (!p.expiresAt || p.expiresAt > now))
    : undefined;
  const repositoryReady = state.reposAuthed;
  const agentAnswered = state.transcript.some((e) => e.role === "assistant" && Boolean(e.text) && !e.tool) ? true : undefined;
  return deriveActivation({ accountSignedIn, machineOnline, agentInstalled, credentialValid, repositoryReady, agentAnswered });
}
