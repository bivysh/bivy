// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * The Effective Session Contract is an observation report, not an
 * attestation — same discipline as Receipt v1 (see receipt-v1.ts): report
 * what was actually observed, keep "requested" and "effective" distinct,
 * and turn every gap into an explicit, typed reason instead of a silent
 * absence or an invented default. `resolveSessionContract` is a pure
 * projection so it is fully testable without a live session; `preview:
 * true` marks a contract computed from catalog/advertised data before a
 * session exists (the agent picker), as opposed to one computed from real
 * launch facts (`preview: false`).
 */
export const SESSION_CONTRACT_SCHEMA_VERSION = "session-contract.v1" as const;

export type ContractGuaranteeState = "guaranteed" | "degraded" | "unavailable";
export type SessionContractSupportTier = "supported" | "beta" | "experimental" | "planned";
export type SessionContractCertification = "release-tested" | "adapter-tested" | "unverified";
export type SessionContractExecutionModeKind = "protocol" | "structured-pipe" | "pipe" | "pty" | "unknown";
export type SessionContractAuthKind = "api_key" | "oauth" | "none" | "unknown";
export type SessionContractAuthOrigin = "bivy" | "agent-native" | "unknown";
export type SessionContractRuntimeEnforcement = "native-sandbox" | "tool-controls" | "mcp-controls" | "user-permissions" | "none";
export type SessionContractEvidenceClass = "enforced" | "observed" | "unavailable";
export type SessionContractApprovalMode = "never" | "risky" | "always" | "autonomous";
export type SessionContractSandboxTier = "read-only" | "workspace-write" | "danger-full-access";
export type SessionContractArea = "agent" | "executionMode" | "auth" | "resume" | "toolInterception" | "sandbox";

export interface SessionContractDegradedReason {
  area: SessionContractArea;
  code: string;
  message: string;
}

export interface SessionContractAgentFacts {
  id: string;
  displayName?: string;
  detectedVersion?: string;
  versionSource: "reported" | "tested-pin" | "unknown";
}

export interface SessionContractExecutionModeFacts {
  effective: SessionContractExecutionModeKind;
  structuredStreaming: boolean;
  state: ContractGuaranteeState;
}

export interface SessionContractModelFacts {
  provider?: string;
  modelId?: string;
  configured: boolean;
}

export interface SessionContractAuthFacts {
  kind: SessionContractAuthKind;
  origin: SessionContractAuthOrigin;
  state: ContractGuaranteeState;
}

export interface SessionContractResumeFacts {
  advertised: boolean;
  refIsPath: boolean;
  state: ContractGuaranteeState;
}

export interface SessionContractToolInterceptionFacts {
  enforced: boolean;
  mcpOnly: boolean;
  approvalMode?: SessionContractApprovalMode;
  state: ContractGuaranteeState;
}

export interface SessionContractSandboxFacts {
  tier?: SessionContractSandboxTier;
  runtimeEnforcement: SessionContractRuntimeEnforcement;
  evidenceClass: SessionContractEvidenceClass;
  state: ContractGuaranteeState;
}

export interface SessionContract {
  schemaVersion: typeof SESSION_CONTRACT_SCHEMA_VERSION;
  /** The instant this contract was resolved, supplied by the caller so
   *  resolution stays deterministic and testable. */
  resolvedAt: string;
  /** True when computed from advertised catalog data before a session
   *  exists (e.g. the agent picker); false when computed from real launch
   *  facts for an actual session. */
  preview: boolean;
  supportTier: SessionContractSupportTier;
  certification: SessionContractCertification;
  agent: SessionContractAgentFacts;
  executionMode: SessionContractExecutionModeFacts;
  model: SessionContractModelFacts;
  auth: SessionContractAuthFacts;
  resume: SessionContractResumeFacts;
  toolInterception: SessionContractToolInterceptionFacts;
  sandbox: SessionContractSandboxFacts;
  /** Every area whose state is not "guaranteed", in a stable, honest,
   *  human-readable form. Never invented — absence of a fact yields an
   *  "unavailable" state and a reason here, not a guessed guarantee. */
  degradedReasons: SessionContractDegradedReason[];
  /** True when this is a "supported" (certified) profile with at least one
   *  protection-relevant area (auth/resume/toolInterception/sandbox)
   *  degraded or unavailable, and no acknowledgement has been recorded yet.
   *  Callers (the launch gate, the picker) must not silently proceed while
   *  this is true. Beta/experimental/planned profiles never set this — they
   *  never promised the guarantee being reduced. */
  requiresAcknowledgement: boolean;
  /** ISO instant the user explicitly acknowledged continuing with the
   *  degraded protections described above, if they have. */
  acknowledgedAt?: string;
}

export interface SessionContractInput {
  /** The instant this contract is being resolved, supplied by the caller. */
  now: string;
  preview: boolean;
  agentId: string;
  agentDisplayName?: string;
  detectedVersion?: string;
  versionSource?: "reported" | "tested-pin";
  supportTier?: SessionContractSupportTier;
  certification?: SessionContractCertification;
  executionMode?: "protocol" | "structured-pipe" | "pipe" | "pty";
  provider?: string;
  modelId?: string;
  modelConfigured?: boolean;
  authKind?: SessionContractAuthKind;
  authOrigin?: SessionContractAuthOrigin;
  resumeAdvertised?: boolean;
  resumeRefIsPath?: boolean;
  toolInterceptionEnforced?: boolean;
  mcpToolApprovalsOnly?: boolean;
  approvalMode?: SessionContractApprovalMode;
  sandboxTier?: SessionContractSandboxTier;
  runtimeEnforcement?: SessionContractRuntimeEnforcement;
  /** ISO instant the user already acknowledged reduced protections for this
   *  exact resolution (e.g. a retried session.new carrying the ack flag). */
  acknowledgedAt?: string;
}

const LIMITATIONS: Record<string, string> = {
  agent_version_unknown: "The running agent's build/version was not reported; capability guarantees fall back to the pinned default.",
  execution_mode_unstructured: "The agent is driven over a raw text pipe, not a structured message/event stream — tool-call and turn boundaries are inferred, not reported.",
  execution_mode_unknown: "The session's communication mode has not been resolved yet.",
  auth_unknown: "The credential kind backing this session was not identified.",
  auth_unconfigured: "No credential is configured for this provider.",
  resume_unsupported: "This agent cannot resume a persisted session; a stopped session restarts from a seeded continuation instead.",
  tool_interception_unavailable: "Tool calls are not intercepted by Bivy's approval gate; the agent runs unmoderated.",
  tool_interception_mcp_only: "Only this agent's MCP tool calls are gated by Bivy's approval flow — its built-in tools are not.",
  sandbox_unavailable: "No sandbox or tool-control enforcement was observed; the agent runs with the OS user's full permissions.",
  sandbox_observed_only: "Containment relies on Bivy's own tool controls rather than the agent's native sandbox — observed, not independently enforced.",
};

function degradedReason(area: SessionContractArea, code: string): SessionContractDegradedReason {
  return { area, code, message: LIMITATIONS[code] ?? code };
}

const PROTECTION_AREAS = new Set<SessionContractArea>(["auth", "resume", "toolInterception", "sandbox"]);

/**
 * Resolve an Effective Session Contract from already-observed facts. Never
 * infers a fact the caller didn't supply — an absent input becomes an honest
 * "unknown"/"unavailable" state plus a typed reason, never a guess.
 */
export function resolveSessionContract(input: SessionContractInput): SessionContract {
  const degradedReasons: SessionContractDegradedReason[] = [];

  const versionSource: SessionContractAgentFacts["versionSource"] = input.detectedVersion
    ? (input.versionSource ?? "reported")
    : "unknown";
  if (versionSource === "unknown") degradedReasons.push(degradedReason("agent", "agent_version_unknown"));
  const agent: SessionContractAgentFacts = {
    id: input.agentId,
    ...(input.agentDisplayName ? { displayName: input.agentDisplayName } : {}),
    ...(input.detectedVersion ? { detectedVersion: input.detectedVersion } : {}),
    versionSource,
  };

  const effectiveMode: SessionContractExecutionModeKind = input.executionMode ?? "unknown";
  const structuredStreaming = effectiveMode === "protocol" || effectiveMode === "structured-pipe";
  const executionModeState: ContractGuaranteeState =
    effectiveMode === "unknown" ? "unavailable" : structuredStreaming ? "guaranteed" : "degraded";
  if (executionModeState === "degraded") degradedReasons.push(degradedReason("executionMode", "execution_mode_unstructured"));
  if (executionModeState === "unavailable") degradedReasons.push(degradedReason("executionMode", "execution_mode_unknown"));
  const executionMode: SessionContractExecutionModeFacts = { effective: effectiveMode, structuredStreaming, state: executionModeState };

  const model: SessionContractModelFacts = {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    configured: input.modelConfigured ?? false,
  };

  const authKind: SessionContractAuthKind = input.authKind ?? "unknown";
  const authState: ContractGuaranteeState = authKind === "unknown" || authKind === "none" ? "unavailable" : "guaranteed";
  if (authKind === "unknown") degradedReasons.push(degradedReason("auth", "auth_unknown"));
  if (authKind === "none") degradedReasons.push(degradedReason("auth", "auth_unconfigured"));
  const auth: SessionContractAuthFacts = { kind: authKind, origin: input.authOrigin ?? "unknown", state: authState };

  const resumeAdvertised = input.resumeAdvertised ?? false;
  const resumeState: ContractGuaranteeState = resumeAdvertised ? "guaranteed" : "unavailable";
  if (!resumeAdvertised) degradedReasons.push(degradedReason("resume", "resume_unsupported"));
  const resume: SessionContractResumeFacts = { advertised: resumeAdvertised, refIsPath: input.resumeRefIsPath ?? false, state: resumeState };

  const toolEnforced = input.toolInterceptionEnforced ?? false;
  const mcpOnly = !toolEnforced && Boolean(input.mcpToolApprovalsOnly);
  const toolState: ContractGuaranteeState = toolEnforced ? "guaranteed" : mcpOnly ? "degraded" : "unavailable";
  if (toolState === "degraded") degradedReasons.push(degradedReason("toolInterception", "tool_interception_mcp_only"));
  if (toolState === "unavailable") degradedReasons.push(degradedReason("toolInterception", "tool_interception_unavailable"));
  const toolInterception: SessionContractToolInterceptionFacts = {
    enforced: toolEnforced,
    mcpOnly,
    ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
    state: toolState,
  };

  const runtimeEnforcement: SessionContractRuntimeEnforcement = input.runtimeEnforcement ?? "none";
  const evidenceClass: SessionContractEvidenceClass =
    runtimeEnforcement === "native-sandbox" ? "enforced" : runtimeEnforcement === "tool-controls" ? "observed" : "unavailable";
  const sandboxState: ContractGuaranteeState =
    evidenceClass === "enforced" ? "guaranteed" : evidenceClass === "observed" ? "degraded" : "unavailable";
  if (sandboxState === "degraded") degradedReasons.push(degradedReason("sandbox", "sandbox_observed_only"));
  if (sandboxState === "unavailable") degradedReasons.push(degradedReason("sandbox", "sandbox_unavailable"));
  const sandbox: SessionContractSandboxFacts = {
    ...(input.sandboxTier ? { tier: input.sandboxTier } : {}),
    runtimeEnforcement,
    evidenceClass,
    state: sandboxState,
  };

  const supportTier = input.supportTier ?? "experimental";
  const hasProtectionDegradation = degradedReasons.some((r) => PROTECTION_AREAS.has(r.area));
  const requiresAcknowledgement = supportTier === "supported" && hasProtectionDegradation && !input.acknowledgedAt;

  return {
    schemaVersion: SESSION_CONTRACT_SCHEMA_VERSION,
    resolvedAt: input.now,
    preview: input.preview,
    supportTier,
    certification: input.certification ?? "unverified",
    agent,
    executionMode,
    model,
    auth,
    resume,
    toolInterception,
    sandbox,
    degradedReasons,
    requiresAcknowledgement,
    ...(input.acknowledgedAt ? { acknowledgedAt: input.acknowledgedAt } : {}),
  };
}
