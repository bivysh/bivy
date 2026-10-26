// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { EphemeralNodeConfig, HostedMachineSummary } from "@bivy/core";

/** One picker row for a deployment-provided cloud destination. `nodeId` set →
 * picking it connects to the account's cloud computer, awake or asleep
 * (connecting wakes it); unset → no computer exists yet and one is created when
 * the first message is sent. */
export interface CloudDestination {
  key: string;
  label: string;
  online: boolean;
  /** The account's cloud computer exists but is asleep: picking it wakes it. */
  asleep: boolean;
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
 * The sleeping cloud computer to wake because this person is in the app, or
 * undefined. Only someone who works on it counts: it's their current machine,
 * they picked Bivy Cloud, or they have no machine of their own (a new device
 * that hasn't been asked yet). Someone who chose their own computer is left
 * alone, as is a computer that is already up.
 */
export function cloudComputerToWake(nodes: NodeLike[], currentNodeId: string, place: "cloud" | "own" | null): string | undefined {
  const computer = nodes.find((node) => isCloudComputerNodeId(node.id));
  if (!computer || computer.online) return undefined;
  if (currentNodeId === computer.id || place === "cloud") return computer.id;
  const ownMachine = nodes.some((node) => !node.id.startsWith("eph-"));
  return place === null && !ownMachine ? computer.id : undefined;
}

/** Whether a machine can be used now. A cloud computer that isn't connected is
 * asleep, not broken: sending to it wakes it. */
export type Presence = "online" | "asleep" | "offline";

export const PRESENCE: Record<Presence, { label: string; hint?: string }> = {
  online: { label: "Online" },
  asleep: { label: "Asleep", hint: "wakes when you send" },
  offline: { label: "Offline" },
};

export function nodePresence(node: NodeLike | undefined): Presence {
  if (node?.online) return "online";
  return isCloudComputerNodeId(node?.id) ? "asleep" : "offline";
}

/**
 * The picker's cloud rows. Each deployment-provided profile ("Bivy Cloud") is
 * ONE destination that reuses the account's cloud computer while it is online
 * and otherwise wakes it on demand.
 */
export function cloudDestinations(
  configs: EphemeralNodeConfig[],
  machines: HostedMachineSummary[],
  nodes: NodeLike[],
): CloudDestination[] {
  const online = (nodeId?: string) => Boolean(nodes.find((node) => node.id === nodeId)?.online);
  const live = machines
    .filter((machine) => isCloudComputerNodeId(machine.nodeId) && online(machine.nodeId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const sleeping = nodes.find((node) => isCloudComputerNodeId(node.id) && !node.online);
  return configs.filter((config) => config.computeSource === "managed").map((config) => {
    const reuse = live[0];
    const asleep = !reuse && Boolean(sleeping);
    return { key: config.id, label: (config.name || "Bivy Cloud").replace(/^Hosted\s+/i, ""), online: Boolean(reuse), asleep, nodeId: reuse?.nodeId ?? sleeping?.id, config };
  });
}
