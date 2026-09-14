// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Provider-neutral machine facts. These values are shared by persistence,
// provider ports, lifecycle projections, and orchestration without importing
// any of their implementations.

import type { EphemeralLifecycleMilestones } from "./ephemeral-lifecycle.js";

export type EphemeralMilestones = EphemeralLifecycleMilestones;

export type EphemeralMachinePurpose = "queue-item" | "queue-default" | "ready-capacity" | "auth-runner" | "interactive";

export interface EphemeralMachine {
  id: string;
  provider: string;
  name: string;
  region: string;
  size?: string;
  status: string;
  ip: string | null;
  createdAt: string;
  /** Stable id for the idempotent launch operation. */
  attemptId?: string;
  milestones?: EphemeralMilestones;
  ttlMinutes?: number;
  teardownOnAgentFinish?: boolean;
  app?: string;
  nodeId?: string;
  setupId?: string;
  repo?: string;
  workItemId?: string;
  purpose?: EphemeralMachinePurpose;
  /** Credential lane that created the Machine. Absent means user/BYO. */
  computeSource?: "user" | "managed";
}

export interface SessionCorrelation {
  sessionId: string;
  nodeId: string;
  provider: string;
  region?: string;
  ttlMinutes?: number;
  repo?: string;
  setupId?: string;
  machineId?: string;
  app?: string;
  computeSource?: "user" | "managed";
}

export function ephemeralMachineFromCorrelation(correlation: SessionCorrelation): EphemeralMachine {
  return {
    id: correlation.machineId || correlation.nodeId,
    provider: correlation.provider,
    name: correlation.nodeId,
    region: correlation.region || "",
    status: "gone",
    ip: null,
    createdAt: "",
    ttlMinutes: correlation.ttlMinutes,
    app: correlation.app,
    nodeId: correlation.nodeId,
    setupId: correlation.setupId,
    repo: correlation.repo,
    computeSource: correlation.computeSource,
  };
}

export function isEphemeralNode(node: {
  id: string;
  ephemeral?: { provider?: string; machineId?: string };
}): boolean {
  return node.id.startsWith("eph-") || Boolean(node.ephemeral?.provider && node.ephemeral?.machineId);
}

export function ephemeralMachineFromNode(node: {
  id: string;
  name?: string;
  ephemeral?: { provider?: string; machineId?: string; app?: string; region?: string };
}): EphemeralMachine | null {
  const identity = node.ephemeral;
  if (!identity?.provider || !identity.machineId) return null;
  return {
    id: identity.machineId,
    provider: identity.provider,
    name: node.name || identity.machineId,
    region: identity.region || "",
    status: "stopped",
    ip: null,
    createdAt: "",
    app: identity.app,
    nodeId: node.id,
  };
}
