// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

// Node-side projection of the canonical dependency-neutral session contract.
// Wire values and pure resolution come from the canonical dependency-neutral
// core source via session-contract-values.ts; this module adds only the
// runtime-facts adapter used by the node composition root.
export {
  SESSION_CONTRACT_SCHEMA_VERSION,
  resolveSessionContract,
  type ContractGuaranteeState,
  type SessionContract,
  type SessionContractAgentFacts,
  type SessionContractApprovalMode,
  type SessionContractArea,
  type SessionContractAuthFacts,
  type SessionContractAuthKind,
  type SessionContractAuthOrigin,
  type SessionContractCertification,
  type SessionContractDegradedReason,
  type SessionContractEvidenceClass,
  type SessionContractExecutionModeFacts,
  type SessionContractExecutionModeKind,
  type SessionContractInput,
  type SessionContractModelFacts,
  type SessionContractResumeFacts,
  type SessionContractRuntimeEnforcement,
  type SessionContractSandboxFacts,
  type SessionContractSandboxTier,
  type SessionContractSupportTier,
  type SessionContractToolInterceptionFacts,
} from "./session-contract-values.js";

import {
  resolveSessionContract,
  type SessionContract,
  type SessionContractApprovalMode,
  type SessionContractAuthKind,
  type SessionContractAuthOrigin,
  type SessionContractCertification,
  type SessionContractRuntimeEnforcement,
  type SessionContractSandboxTier,
  type SessionContractSupportTier,
} from "./session-contract-values.js";

/** The subset of `RuntimeInfo` (src/agents/types.ts's `AgentInfo`) this module
 *  needs — kept narrow and structural so callers don't have to import the
 *  full runtime registry type into test code. */
export interface SessionContractRuntimeFacts {
  id: string;
  displayName?: string;
  executionMode?: "protocol" | "structured-pipe" | "pipe" | "pty";
  supportTier?: SessionContractSupportTier;
  certification?: SessionContractCertification;
  testedVersion?: string;
  protectionLevel?: SessionContractRuntimeEnforcement;
  authOwner?: "bivy" | "agent" | "mixed";
  capabilities?: {
    resume?: boolean;
    sessionRefIsPath?: boolean;
    toolInterception?: boolean;
    mcpToolApprovals?: boolean;
  };
}

export interface SessionContractSourceFacts {
  runtime: SessionContractRuntimeFacts;
  preview: boolean;
  sandbox?: SessionContractSandboxTier;
  approvalMode?: SessionContractApprovalMode;
  provider?: string;
  modelId?: string;
  modelConfigured?: boolean;
  /** Resolved credential kind, when a caller has it (not every runtime path
   *  threads this through yet — see docs on the "unknown" fallback below). */
  authKind?: SessionContractAuthKind;
  acknowledgedAt?: string;
}

/**
 * Map real node-side facts (a resolved `RuntimeInfo`, the chosen sandbox
 * tier/approval mode, and whatever credential facts the caller has) into an
 * Effective Session Contract. `authKind` defaults to "unknown" rather than
 * guessing from `authOwner` — origin (bivy vault vs. the agent's own login)
 * is a structural fact `authOwner` already reports honestly; the specific
 * credential *kind* (api_key vs oauth) is not yet threaded through from
 * every runtime's credential resolution and must not be invented.
 */
export function computeSessionContract(facts: SessionContractSourceFacts, now: string): SessionContract {
  const runtime = facts.runtime;
  const caps = runtime.capabilities ?? {};
  const authOrigin: SessionContractAuthOrigin =
    runtime.authOwner === "bivy" ? "bivy" : runtime.authOwner === "agent" ? "agent-native" : "unknown";
  return resolveSessionContract({
    now,
    preview: facts.preview,
    agentId: runtime.id,
    agentDisplayName: runtime.displayName,
    detectedVersion: runtime.testedVersion,
    versionSource: runtime.testedVersion ? "tested-pin" : undefined,
    supportTier: runtime.supportTier,
    certification: runtime.certification,
    executionMode: runtime.executionMode,
    provider: facts.provider,
    modelId: facts.modelId,
    modelConfigured: facts.modelConfigured,
    authKind: facts.authKind,
    authOrigin,
    resumeAdvertised: caps.resume === true,
    resumeRefIsPath: caps.sessionRefIsPath === true,
    toolInterceptionEnforced: caps.toolInterception === true,
    mcpToolApprovalsOnly: caps.mcpToolApprovals === true,
    approvalMode: facts.approvalMode,
    sandboxTier: facts.sandbox,
    runtimeEnforcement: runtime.protectionLevel,
    acknowledgedAt: facts.acknowledgedAt,
  });
}
