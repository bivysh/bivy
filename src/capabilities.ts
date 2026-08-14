// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The Machine capability inventory: a typed, non-sensitive snapshot of what a
// connected Machine actually unlocks for agents — OS/architecture, installed
// maintained/custom agents, configured model providers/local endpoints, Docker
// and GPU availability, installed plugins, and a bounded workspace count. This
// is capability *discovery*, not a deep scan: every field is either a short id
// list, a count, or a tri-state probe result. Nothing here ever carries file
// paths, process command lines, secrets, database names, private endpoints, or
// network interfaces.
//
// Canonical source lives here (not @bivy/core): the root node/CLI deliberately
// does not depend on packages/* (see src/session/inline-image-fetch.ts's note),
// and redaction/bounding of raw node-gathered facts must happen server-side
// before a snapshot ever reaches a client, not merely be trusted of one. The
// PWA's `packages/core/src/capabilities.ts` mirrors the wire *shape* only
// (types + small rendering helpers, no normalization) — kept in lock-step by
// comment, the same convention EPHEMERAL_ALLOWED_HOSTS uses. If you change the
// shape here, change that file too.
//
// `normalizeCapabilities` is the pure projection (mirrors packages/core's
// activation.ts `deriveActivation`): the node gathers raw facts from its own
// canonical stores/probes, and this function bounds list lengths and drops
// anything outside the redacted shape below before the snapshot is sent.

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface CapabilityProbeResult {
  state: CapabilityState;
  /** Short, non-sensitive, customer-readable detail (e.g. "Docker 27.3.1"). */
  detail?: string;
}

export type CapabilityAgentKind = "maintained" | "custom";

export interface CapabilityAgentSummary {
  id: string;
  label: string;
  kind: CapabilityAgentKind;
  /** Whether the agent's CLI/integration was actually found on this Machine —
   *  not merely known to Bivy. */
  installed: boolean;
  supportTier?: string;
}

export interface CapabilityPluginSummary {
  id: string;
  name?: string;
  version?: string;
  /** Whether the plugin's manifest parsed and validated. */
  valid: boolean;
  agentCount: number;
}

export interface CapabilityLocalEndpointSummary {
  /** Configured local/custom model endpoints (e.g. Ollama, LM Studio, vLLM).
   *  Counted from Bivy's local-model registry only — this inventory never
   *  probes a local endpoint's port itself (a separate, active-discovery
   *  feature owns that). */
  count: number;
  /** Of those, how many have at least one model configured. */
  withModels: number;
}

export interface MachineCapabilities {
  generatedAt: string;
  os: {
    platform: string;
    arch: string;
    release: string;
    type: string;
  };
  agents: {
    maintained: CapabilityAgentSummary[];
    custom: CapabilityAgentSummary[];
  };
  providers: {
    /** Provider ids with a stored credential (e.g. "anthropic", "openai") —
     *  never key material, tokens, or expiry details. */
    configured: string[];
    localEndpoints: CapabilityLocalEndpointSummary;
  };
  docker: CapabilityProbeResult;
  gpu: CapabilityProbeResult;
  plugins: CapabilityPluginSummary[];
  /** Configured workspace count — a bound, not an enumeration of paths. */
  workspaces: { count: number };
}

/** The raw, not-yet-bounded facts the node gathers from its own canonical
 *  stores/probes before {@link normalizeCapabilities} redacts and bounds them
 *  into a {@link MachineCapabilities} snapshot. Untrusted in the sense that a
 *  misbehaving/huge source list must never reach a client unbounded. */
export interface RawCapabilityInputs {
  os: { platform: string; arch: string; release: string; type: string };
  agents: CapabilityAgentSummary[];
  configuredProviderIds: string[];
  localEndpoints: Array<{ id: string; modelCount: number }>;
  docker?: CapabilityProbeResult;
  gpu?: CapabilityProbeResult;
  plugins: CapabilityPluginSummary[];
  workspaceCount: number;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  now?: number;
}

const MAX_AGENTS = 200;
const MAX_PROVIDERS = 100;
const MAX_PLUGINS = 200;

function normalizeProbe(probe: CapabilityProbeResult | undefined): CapabilityProbeResult {
  if (!probe || (probe.state !== "available" && probe.state !== "unavailable" && probe.state !== "unknown")) {
    return { state: "unknown" };
  }
  const detail = typeof probe.detail === "string" ? probe.detail.trim().slice(0, 200) : undefined;
  return detail ? { state: probe.state, detail } : { state: probe.state };
}

function boundAgents(agents: CapabilityAgentSummary[], kind: CapabilityAgentKind): CapabilityAgentSummary[] {
  return agents
    .filter((agent) => agent.kind === kind)
    .slice(0, MAX_AGENTS)
    .map((agent) => ({
      id: agent.id,
      label: agent.label,
      kind: agent.kind,
      installed: Boolean(agent.installed),
      ...(agent.supportTier ? { supportTier: agent.supportTier } : {}),
    }));
}

/** Project raw, node-gathered facts into the bounded, redacted
 *  {@link MachineCapabilities} snapshot. Every probe defaults to `"unknown"`
 *  rather than throwing when absent, every list is capped, and provider/plugin
 *  entries are rebuilt field-by-field so an oversized or unexpectedly-shaped
 *  input can never smuggle extra (potentially sensitive) fields through. */
export function normalizeCapabilities(raw: RawCapabilityInputs): MachineCapabilities {
  const localEndpoints = raw.localEndpoints ?? [];
  const configuredProviderIds = [...new Set(raw.configuredProviderIds)].slice(0, MAX_PROVIDERS);
  return {
    generatedAt: new Date(raw.now ?? Date.now()).toISOString(),
    os: {
      platform: raw.os.platform,
      arch: raw.os.arch,
      release: raw.os.release,
      type: raw.os.type,
    },
    agents: {
      maintained: boundAgents(raw.agents, "maintained"),
      custom: boundAgents(raw.agents, "custom"),
    },
    providers: {
      configured: configuredProviderIds,
      localEndpoints: {
        count: localEndpoints.length,
        withModels: localEndpoints.filter((endpoint) => endpoint.modelCount > 0).length,
      },
    },
    docker: normalizeProbe(raw.docker),
    gpu: normalizeProbe(raw.gpu),
    plugins: raw.plugins.slice(0, MAX_PLUGINS).map((plugin) => ({
      id: plugin.id,
      valid: Boolean(plugin.valid),
      agentCount: Math.max(0, Math.trunc(plugin.agentCount) || 0),
      ...(plugin.name ? { name: plugin.name } : {}),
      ...(plugin.version ? { version: plugin.version } : {}),
    })),
    workspaces: { count: Math.max(0, Math.trunc(raw.workspaceCount) || 0) },
  };
}
