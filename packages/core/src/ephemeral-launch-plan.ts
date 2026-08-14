// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Ephemeral launch decisions as immutable data. Enrollment, randomness, clocks,
// provider calls, and persistence happen outside; this module only combines the
// supplied facts into a plan and projects a provider result into tracked data.

import type { EphemeralMachine, EphemeralMachinePurpose } from "./ephemeral-machine.js";
import type { ProviderProvisionConfig } from "./ephemeral-provider-ports.js";

export interface EphemeralLaunchPlanInput {
  provider: string;
  attemptId: string;
  nodeId: string;
  requestedAt: string;
  defaultRegion: string;
  defaultSize: string;
  region?: string;
  size?: string;
  image?: string;
  ttlMinutes?: number;
  repo?: string;
  name?: string;
  setupId?: string;
  teardownOnAgentFinish?: boolean;
  debugKeepMachine?: boolean;
  workItemId?: string;
  purpose?: EphemeralMachinePurpose;
  ownershipTag?: string;
}

export interface EphemeralLaunchPlan {
  attemptId: string;
  nodeId: string;
  requestedAt: string;
  provider: string;
  region: string;
  size: string;
  providerConfig: ProviderProvisionConfig;
  machineFacts: Partial<Pick<EphemeralMachine, "name" | "setupId" | "repo" | "teardownOnAgentFinish" | "workItemId" | "purpose">>;
}

export function ephemeralNodeLabel(nodeId: string): string {
  return nodeId.replace(/^eph-/, "");
}

export function planEphemeralLaunch(input: EphemeralLaunchPlanInput): EphemeralLaunchPlan {
  const region = input.region || input.defaultRegion;
  const size = input.size || input.defaultSize;
  const label = ephemeralNodeLabel(input.nodeId);
  const chosenName = String(input.name || "").trim();
  return {
    attemptId: input.attemptId,
    nodeId: input.nodeId,
    requestedAt: input.requestedAt,
    provider: input.provider,
    region,
    size,
    providerConfig: {
      slug: label,
      region,
      size,
      image: input.image,
      ttlMinutes: input.ttlMinutes,
      attemptId: input.attemptId,
      ownershipTag: input.ownershipTag,
    },
    machineFacts: {
      ...(chosenName ? { name: chosenName } : {}),
      ...(input.setupId ? { setupId: input.setupId } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.teardownOnAgentFinish ? { teardownOnAgentFinish: true } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    },
  };
}

export function trackProvisionedMachine(
  provisioned: EphemeralMachine,
  plan: EphemeralLaunchPlan,
  providerAcceptedAt: string,
): EphemeralMachine {
  return {
    ...provisioned,
    ...plan.machineFacts,
    attemptId: plan.attemptId,
    nodeId: plan.nodeId,
    size: plan.size,
    milestones: {
      ...(provisioned.milestones ?? {}),
      requestedAt: plan.requestedAt,
      providerAcceptedAt,
    },
  };
}
