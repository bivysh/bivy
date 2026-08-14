// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Client-side mirror of the Machine capability inventory wire shape. The
// canonical type and the redaction/bounding logic that builds it live in
// src/capabilities.ts (node-side) — the root node/CLI deliberately does not
// depend on @bivy/core (see src/session/inline-image-fetch.ts's note), so
// this file re-declares only the wire *shape* plus small, framework-agnostic
// rendering helpers the PWA needs. Kept in lock-step by comment, the same
// convention EPHEMERAL_ALLOWED_HOSTS uses for its cross-copy host allowlist:
// if you change one file's shape, change the other's.

/** Honest tri-state for anything Bivy cannot always determine for certain: a
 *  probe can succeed (`available`), fail conclusively (`unavailable`), or be
 *  inconclusive — timed out, or a case Bivy deliberately does not scan deeper
 *  for (`unknown`). Never collapsed to a boolean, so a client can render
 *  "unknown" honestly instead of guessing. */
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
  installed: boolean;
  supportTier?: string;
}

export interface CapabilityPluginSummary {
  id: string;
  name?: string;
  version?: string;
  valid: boolean;
  agentCount: number;
}

export interface CapabilityLocalEndpointSummary {
  count: number;
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
    configured: string[];
    localEndpoints: CapabilityLocalEndpointSummary;
  };
  docker: CapabilityProbeResult;
  gpu: CapabilityProbeResult;
  plugins: CapabilityPluginSummary[];
  workspaces: { count: number };
}

/** Human phrasing for a capability tri-state, shared across the PWA so the
 *  "available / unavailable / unknown" vocabulary never drifts between
 *  surfaces. Deliberately never says "online"/"offline" — those describe the
 *  Machine's connection, not what it unlocks. */
export function describeCapabilityState(state: CapabilityState): string {
  switch (state) {
    case "available":
      return "Available";
    case "unavailable":
      return "Not available";
    case "unknown":
      return "Unknown";
  }
}

/** Tally of a probe/agent list's states for a compact summary line (e.g. "3
 *  available, 1 unknown"). */
export function summarizeCapabilityStates(states: readonly CapabilityState[]): Record<CapabilityState, number> {
  const out: Record<CapabilityState, number> = { available: 0, unavailable: 0, unknown: 0 };
  for (const state of states) out[state] += 1;
  return out;
}
