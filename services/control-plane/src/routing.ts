// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Secret-free, deterministic automation routing.
 *
 * Callers assemble snapshots from node/provider metadata and keep credentials on
 * the node/device. `ephemeral.credentialAvailable` is only a boolean assertion
 * from that device; no token ever enters the decision or persisted explanation.
 */

export type RouteReasonCode =
  | "node_offline"
  | "node_label_required"
  | "os_required"
  | "capability_required"
  | "runtime_required"
  | "runtime_not_allowed"
  | "model_required"
  | "model_not_allowed"
  | "provider_not_allowed"
  | "provider_auth_missing"
  | "provider_quota_exhausted"
  | "repository_unreachable"
  | "sandbox_unsupported"
  | "approval_policy_unsupported"
  | "preferred_node"
  | "preferred_runtime"
  | "preferred_model"
  | "persistent_preferred"
  | "fallback_selected"
  | "waiting_for_preferred"
  | "ephemeral_not_allowed"
  | "ephemeral_credential_missing";

export interface RouteReason {
  code: RouteReasonCode;
  message: string;
  hard: boolean;
}

export interface ProviderCapability {
  id: string;
  authenticated: boolean;
  /** undefined means the provider did not report quota, not that quota exists. */
  quota?: "available" | "exhausted";
  models: string[];
}

export interface RoutingNode {
  id: string;
  label: string;
  online: boolean;
  persistent: boolean;
  os: string;
  capabilities: string[];
  runtimes: string[];
  providers: ProviderCapability[];
  repositories: string[];
  sandboxPolicies: string[];
  approvalPolicies: string[];
}

export interface EphemeralRoute {
  provider: string;
  credentialAvailable: boolean;
  os: string;
  capabilities: string[];
  runtimes: string[];
  modelProviders: ProviderCapability[];
  repositories: string[];
  sandboxPolicies: string[];
  approvalPolicies: string[];
}

export interface RoutingPolicy {
  requiredNodeLabel?: string;
  preferredNodeLabel?: string;
  requiredOs?: string;
  requiredCapabilities?: string[];
  requiredRuntime?: string;
  preferredRuntimes?: string[];
  allowedRuntimes?: string[];
  requiredModel?: string;
  preferredModels?: string[];
  allowedModels?: string[];
  allowedProviders?: string[];
  repository?: string;
  requiredSandboxPolicy: string;
  requiredApprovalPolicy: string;
  preferPersistent?: boolean;
  allowEphemeral?: boolean;
  /** Milliseconds to reserve an offline preferred node before using fallback. */
  maxWaitMs?: number;
}

export interface RouteCandidate {
  kind: "node" | "ephemeral";
  id: string;
  nodeId?: string;
  nodeLabel?: string;
  runtime?: string;
  model?: string;
  provider?: string;
  viable: boolean;
  score: number;
  reasons: RouteReason[];
}

export type RoutingDecision =
  | { status: "selected"; selected: RouteCandidate; candidates: RouteCandidate[]; reasons: RouteReason[] }
  | { status: "waiting"; waitUntil: number; candidates: RouteCandidate[]; reasons: RouteReason[] }
  | { status: "needs_attention"; candidates: RouteCandidate[]; reasons: RouteReason[] };

function includesFold(values: string[], wanted: string): boolean {
  const needle = wanted.toLowerCase();
  return values.some((value) => value.toLowerCase() === needle);
}

function reason(code: RouteReasonCode, message: string, hard: boolean): RouteReason {
  return { code, message, hard };
}

function chooseOrdered(available: string[], required: string | undefined, preferred: string[] = [], allowed?: string[]): string | undefined {
  if (required) return includesFold(available, required) ? available.find((v) => v.toLowerCase() === required.toLowerCase()) : undefined;
  const authorized = allowed ? available.filter((v) => includesFold(allowed, v)) : available;
  for (const value of preferred) {
    const match = authorized.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
    if (match) return match;
  }
  return [...authorized].sort((a, b) => a.localeCompare(b))[0];
}

function evaluateCandidate(
  node: RoutingNode,
  policy: RoutingPolicy,
  kind: "node" | "ephemeral",
  ephemeralProvider?: string,
): RouteCandidate {
  const reasons: RouteReason[] = [];
  let score = 0;
  if (!node.online) reasons.push(reason("node_offline", `${node.label} is offline.`, true));
  if (policy.requiredNodeLabel && node.label !== policy.requiredNodeLabel) {
    reasons.push(reason("node_label_required", `Requires node ${policy.requiredNodeLabel}.`, true));
  }
  if (policy.requiredOs && node.os.toLowerCase() !== policy.requiredOs.toLowerCase()) {
    reasons.push(reason("os_required", `Requires ${policy.requiredOs}; ${node.label} reports ${node.os}.`, true));
  }
  for (const capability of [...(policy.requiredCapabilities ?? [])].sort()) {
    if (!includesFold(node.capabilities, capability)) {
      reasons.push(reason("capability_required", `${node.label} lacks required capability ${capability}.`, true));
    }
  }

  const runtime = chooseOrdered(node.runtimes, policy.requiredRuntime, policy.preferredRuntimes, policy.allowedRuntimes);
  if (policy.requiredRuntime && !runtime) reasons.push(reason("runtime_required", `${node.label} does not have required agent ${policy.requiredRuntime}.`, true));
  else if (!runtime) reasons.push(reason("runtime_not_allowed", `${node.label} has no allowed agent.`, true));
  else if (policy.preferredRuntimes?.some((v) => v.toLowerCase() === runtime.toLowerCase())) {
    score += 200 - (policy.preferredRuntimes.findIndex((v) => v.toLowerCase() === runtime.toLowerCase()) * 10);
    reasons.push(reason("preferred_runtime", `Uses preferred agent ${runtime}.`, false));
  }

  const providers = [...node.providers].sort((a, b) => a.id.localeCompare(b.id));
  const modelChoices = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const authorizedModels = modelChoices.filter(({ provider, model }) =>
    (!policy.allowedProviders || includesFold(policy.allowedProviders, provider.id))
    && (!policy.allowedModels || includesFold(policy.allowedModels, model)));
  const operationalModels = authorizedModels.filter(({ provider }) => provider.authenticated && provider.quota !== "exhausted");
  const desiredModels = policy.requiredModel ? [policy.requiredModel] : [...(policy.preferredModels ?? [])];
  let modelChoice = desiredModels
    .map((wanted) => operationalModels.find(({ model }) => model.toLowerCase() === wanted.toLowerCase()))
    .find(Boolean);
  modelChoice ??= operationalModels[0];
  // When nothing is operational, retain an authorized choice solely so the
  // structured reason identifies auth/quota as the blocker.
  modelChoice ??= authorizedModels[0];

  if (policy.requiredModel && !modelChoice) reasons.push(reason("model_required", `${node.label} cannot run required model ${policy.requiredModel}.`, true));
  else if ((policy.allowedModels || policy.allowedProviders) && !modelChoice) {
    reasons.push(reason(policy.allowedProviders ? "provider_not_allowed" : "model_not_allowed", `${node.label} has no explicitly allowed model route.`, true));
  }
  if (modelChoice) {
    if (!modelChoice.provider.authenticated) reasons.push(reason("provider_auth_missing", `${modelChoice.provider.id} authentication is unavailable on ${node.label}.`, true));
    if (modelChoice.provider.quota === "exhausted") reasons.push(reason("provider_quota_exhausted", `${modelChoice.provider.id} reports exhausted quota on ${node.label}.`, true));
    if (policy.preferredModels?.some((v) => v.toLowerCase() === modelChoice!.model.toLowerCase())) {
      score += 100 - (policy.preferredModels.findIndex((v) => v.toLowerCase() === modelChoice!.model.toLowerCase()) * 5);
      reasons.push(reason("preferred_model", `Uses preferred model ${modelChoice.model}.`, false));
    }
  }

  if (policy.repository && !includesFold(node.repositories, policy.repository)) {
    reasons.push(reason("repository_unreachable", `${policy.repository} is not reachable from ${node.label}.`, true));
  }
  if (!includesFold(node.sandboxPolicies, policy.requiredSandboxPolicy)) {
    reasons.push(reason("sandbox_unsupported", `${node.label} cannot enforce sandbox policy ${policy.requiredSandboxPolicy}.`, true));
  }
  if (!includesFold(node.approvalPolicies, policy.requiredApprovalPolicy)) {
    reasons.push(reason("approval_policy_unsupported", `${node.label} cannot enforce approval policy ${policy.requiredApprovalPolicy}.`, true));
  }
  if (node.label === policy.preferredNodeLabel) {
    score += 1_000;
    reasons.push(reason("preferred_node", `${node.label} is the preferred node.`, false));
  }
  if (policy.preferPersistent !== false && node.persistent) {
    score += 25;
    reasons.push(reason("persistent_preferred", `${node.label} is persistent.`, false));
  }
  return {
    kind,
    id: kind === "node" ? node.id : `ephemeral:${ephemeralProvider ?? node.id}`,
    ...(kind === "node" ? { nodeId: node.id } : {}),
    ...(kind === "node" ? { nodeLabel: node.label } : {}),
    ...(runtime ? { runtime } : {}),
    ...(modelChoice ? { model: modelChoice.model, provider: modelChoice.provider.id } : {}),
    viable: !reasons.some((entry) => entry.hard),
    score,
    reasons,
  };
}

export function decideRoute(input: {
  policy: RoutingPolicy;
  nodes: RoutingNode[];
  ephemeral?: EphemeralRoute;
  queuedAt: number;
  now: number;
}): RoutingDecision {
  const persistent = input.nodes.map((node) => evaluateCandidate(node, input.policy, "node"));
  const candidates = [...persistent];
  if (input.ephemeral) {
    const e = input.ephemeral;
    const synthetic: RoutingNode = {
      id: e.provider,
      label: "ephemeral",
      online: true,
      persistent: false,
      os: e.os,
      capabilities: e.capabilities,
      runtimes: e.runtimes,
      providers: e.modelProviders,
      repositories: e.repositories,
      sandboxPolicies: e.sandboxPolicies,
      approvalPolicies: e.approvalPolicies,
    };
    const candidate = evaluateCandidate(synthetic, { ...input.policy, requiredNodeLabel: undefined, preferredNodeLabel: undefined }, "ephemeral", e.provider);
    if (!input.policy.allowEphemeral) candidate.reasons.push(reason("ephemeral_not_allowed", "Ephemeral fallback is not authorized by this routing policy.", true));
    if (!e.credentialAvailable) candidate.reasons.push(reason("ephemeral_credential_missing", `This device has no credential for ephemeral provider ${e.provider}.`, true));
    candidate.viable = !candidate.reasons.some((entry) => entry.hard);
    candidates.push(candidate);
  }

  candidates.sort((a, b) => Number(b.viable) - Number(a.viable) || b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const preferredOffline = input.policy.preferredNodeLabel
    ? input.nodes.find((node) => node.label === input.policy.preferredNodeLabel && !node.online)
    : undefined;
  const waitUntil = input.queuedAt + Math.max(0, input.policy.maxWaitMs ?? 0);
  if (preferredOffline && input.now < waitUntil) {
    return {
      status: "waiting",
      waitUntil,
      candidates,
      reasons: [reason("waiting_for_preferred", `Waiting for preferred node ${preferredOffline.label} until ${new Date(waitUntil).toISOString()}.`, false)],
    };
  }

  const selected = candidates.find((candidate) => candidate.viable);
  if (selected) {
    const fallback = selected.kind === "ephemeral"
      || Boolean(input.policy.preferredNodeLabel
        && input.nodes.find((node) => node.id === selected.nodeId)?.label !== input.policy.preferredNodeLabel);
    const reasons = [...selected.reasons];
    if (fallback) reasons.push(reason("fallback_selected", `Selected authorized fallback ${selected.id}.`, false));
    return { status: "selected", selected, candidates, reasons };
  }
  const blocked = candidates.flatMap((candidate) => candidate.reasons.filter((entry) => entry.hard));
  return {
    status: "needs_attention",
    candidates,
    reasons: blocked.length ? blocked : [reason("node_offline", "No routing candidates are available.", true)],
  };
}
