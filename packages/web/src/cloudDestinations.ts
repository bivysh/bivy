// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { CLOUD_RUNNER_CONFIG_ID, type EphemeralNodeConfig, type HostedMachineSummary } from "@bivy/core";

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
  /** A new runner for this session: never an existing machine, and started
   * only when the first message is sent. */
  runner?: boolean;
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

/** A runner the deployment started for a session or a piece of work. */
export function isRunnerNodeId(nodeId: string | null | undefined): boolean {
  return Boolean(nodeId?.startsWith("eph-runner-"));
}

/** Deployment machines that sleep when quiet and wake on use: the cloud
 * computer and a session's runner. (A runner for queued work ends instead,
 * and its node goes with it.) */
export function isSleepingMachineNodeId(nodeId: string | null | undefined): boolean {
  return isCloudComputerNodeId(nodeId ?? undefined) || isRunnerNodeId(nodeId);
}

/** The notice for a session on a sleeping runner the deployment will delete
 * at `deleteAt`, or undefined. It turns into a warning in the last two days. */
export function runnerDeletionNotice(deleteAt: string | undefined, now = Date.now()): { day: string; soon: boolean } | undefined {
  const at = deleteAt ? Date.parse(deleteAt) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const day = new Date(at).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  return { day, soon: at - now <= 2 * 86_400_000 };
}

/** Whether a machine can be used now. A cloud computer or session runner that
 * isn't connected is asleep, not broken: sending to it wakes it. */
export type Presence = "online" | "asleep" | "offline";

export const PRESENCE: Record<Presence, { label: string; hint?: string }> = {
  online: { label: "Online" },
  asleep: { label: "Asleep", hint: "wakes when you send" },
  offline: { label: "Offline" },
};

export function nodePresence(node: NodeLike | undefined): Presence {
  if (node?.online) return "online";
  return isSleepingMachineNodeId(node?.id) ? "asleep" : "offline";
}

/**
 * The picker's cloud rows. Each deployment-provided profile ("Bivy Cloud") is
 * ONE destination that reuses the account's cloud computer while it is online
 * and otherwise wakes it on demand. A deployment that runs runners also
 * offers "Cloud Runner": a new machine for each session.
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
  return configs.filter((config) => config.computeSource === "managed").flatMap((config) => {
    const reuse = live[0];
    const asleep = !reuse && Boolean(sleeping);
    const computer: CloudDestination = { key: config.id, label: (config.name || "Bivy Cloud").replace(/^Hosted\s+/i, ""), online: Boolean(reuse), asleep, nodeId: reuse?.nodeId ?? sleeping?.id, config };
    if (!config.runners) return [computer];
    const runner = { ...config, id: CLOUD_RUNNER_CONFIG_ID, name: "Cloud Runner" };
    return [computer, { key: runner.id, label: runner.name, online: false, asleep: false, runner: true, config: runner }];
  });
}
