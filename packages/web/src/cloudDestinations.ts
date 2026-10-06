// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { EphemeralNodeConfig, HostedMachineSummary } from "@bivy/core";

/** One picker row for a deployment-provided cloud destination. `nodeId` set →
 * picking it reuses that running Machine; unset → a Machine launches when the
 * first message is sent. */
export interface CloudDestination {
  key: string;
  label: string;
  online: boolean;
  nodeId?: string;
  config: EphemeralNodeConfig;
}

interface NodeLike { id: string; online?: boolean }

/** The account's cloud computer: one deployment-provided node that sleeps when
 * quiet and wakes when used. */
export function isCloudComputerNodeId(nodeId: string | undefined): boolean {
  return Boolean(nodeId?.startsWith("eph-managed-auto-"));
}

/**
 * The picker's cloud rows. Each deployment-provided profile ("Bivy Cloud") is
 * ONE destination that reuses its newest online Machine and otherwise starts one
 * on demand, so the user never chooses between a template and its instances.
 */
export function cloudDestinations(
  configs: EphemeralNodeConfig[],
  machines: HostedMachineSummary[],
  nodes: NodeLike[],
): CloudDestination[] {
  const online = (nodeId?: string) => Boolean(nodes.find((node) => node.id === nodeId)?.online);
  const live = machines
    .filter((machine) => machine.purpose === "interactive" && machine.desiredState !== "deleted" && online(machine.nodeId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return configs.filter((config) => config.computeSource === "managed").map((config) => {
    // A per-session Machine names its profile; the account's cloud computer is
    // recognised by its node id.
    const reuse = live.find((machine) => machine.setupId === config.id || isCloudComputerNodeId(machine.nodeId));
    return { key: config.id, label: (config.name || "Bivy Cloud").replace(/^Hosted\s+/i, ""), online: Boolean(reuse), nodeId: reuse?.nodeId, config };
  });
}
