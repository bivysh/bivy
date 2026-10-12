// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The account's cloud computer: one deployment-provided node per account that
// sleeps when quiet and wakes on use. The deployment extension owns the fleet
// (which machine, when to start/stop, volumes, reconcile); Core owns the node's
// identity and the boot payload, and tells the extension when the machine is
// needed. The machine holds its own keys like any user-owned node: its room key
// is generated on its disk and reaches devices only by pairing, so the control
// plane never has it.
import { createHash } from "node:crypto";
import { ephemeralNodeLabel, flyMachineBoot, type BootstrapOpts } from "@bivy/core";
import { centralGithubAppConfig, resolveGithubIdentity } from "./central-github-app.js";
import type { CentralGithubAppRepository, EphemeralConfigurationRepository, HostedMachineRepository, NodeRepository, QueueRouting, WorkQueueRepository } from "./store.js";

/** Stable for the life of the account, so it is also the automation target:
 * instructions are sealed to the key this node generated for itself. */
export function cloudComputerNodeId(accountId: string): string {
  return `eph-managed-auto-${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`;
}

/** Boot milestones a cloud computer reports for its current awake period. */
export const EPHEMERAL_MILESTONES = [
  "nodeReadyAt",
  "credentialsReadyAt",
  "repositoryReadyAt",
  "snapshotReadyAt",
  "firstAgentEventAt",
  "firstTokenAt",
] as const;
export type EphemeralMilestone = (typeof EPHEMERAL_MILESTONES)[number];

export function isEphemeralMilestone(value: string): value is EphemeralMilestone {
  return (EPHEMERAL_MILESTONES as readonly string[]).includes(value);
}

export function isCloudComputerNode(accountId: string, nodeId: string | null | undefined): boolean {
  return Boolean(nodeId) && nodeId === cloudComputerNodeId(accountId);
}

export interface CloudComputerBootInput {
  accountId: string;
  /** Upper bound on one awake period; the node sleeps itself when quiet. */
  awakeCapMinutes: number;
  relayUrl: string;
  controlPlaneUrl: string;
}

export interface CloudComputerBoot {
  nodeId: string;
  files: { guest_path: string; raw_value: string }[];
  init: { exec: string[] };
}

/**
 * Re-enroll the account's cloud computer and build its Fly boot payload. A
 * fresh enrollment token is issued every time (re-enrollment revokes the
 * previous one). The payload carries no room key: the node keeps the one it
 * generated in its data dir on the persistent volume, or mints one on a new
 * disk. A new disk therefore cannot open snapshots sealed under the old key;
 * sessions from a lost disk are not restored.
 */
export async function bootCloudComputer(
  store: Pick<NodeRepository, "enrollNode"> & Pick<HostedMachineRepository, "getHostedProvisioning"> & Pick<CentralGithubAppRepository, "listCentralGithubInstallations">,
  input: CloudComputerBootInput,
): Promise<CloudComputerBoot> {
  const { accountId } = input;
  const nodeId = cloudComputerNodeId(accountId);
  const { enrollmentToken } = await store.enrollNode(accountId, nodeId, "Bivy Cloud");
  // With an app identity the machine mints short-lived installation tokens per
  // git op; with only a stored PAT it carries that token, as before.
  const hosted = await store.getHostedProvisioning(accountId);
  const central = centralGithubAppConfig();
  const identity = resolveGithubIdentity({
    hosted,
    central,
    centralInstallations: central ? await store.listCentralGithubInstallations(accountId) : [],
  });
  const bootstrap: BootstrapOpts = {
    relayUrl: input.relayUrl,
    controlPlaneUrl: input.controlPlaneUrl,
    enrollmentToken,
    ttlMinutes: input.awakeCapMinutes,
    provider: "fly",
    // Sleep after the idle window, not when a turn ends: previews, a reopened
    // app and the next message should find it awake.
    sleepOnIdle: true,
    // One machine serves the user's sessions and their automations.
    hostedTasks: true,
    nodeLabel: ephemeralNodeLabel(nodeId),
    // Model credentials reach it like any node: end-to-end account vault sync
    // from the user's other machines, or a provider sign-in on the machine.
    hostedMint: identity?.kind === "app",
    githubToken: identity?.kind === "token" ? identity.token : undefined,
  };
  return { nodeId, ...flyMachineBoot(bootstrap) };
}

export interface CloudComputerReadiness { ready: boolean; reason: string; configId?: string }

/** The managed config the account's automation routing sends work to: a config
 * primary, or a node primary's fallback config. */
function routedManagedConfigId(routing: QueueRouting, managedIds: Set<string>): string | undefined {
  const configId = routing.primary.kind === "config" ? routing.primary.configId
    : routing.primary.kind === "node" ? routing.fallback?.configId
    : undefined;
  return configId && managedIds.has(configId) ? configId : undefined;
}

/**
 * Static automation capability for the settings UI: whether unattended work
 * routed to the deployment's cloud can run. It does not inspect pending work or
 * node liveness. `offered` is whether the deployment supplies compute here.
 */
export async function cloudComputerReadiness(
  store: Pick<EphemeralConfigurationRepository, "getQueueRouting" | "getEphemeralConfigs"> & Pick<HostedMachineRepository, "getHostedProvisioning">,
  accountId: string,
  offered: boolean,
): Promise<CloudComputerReadiness> {
  if (!offered) return { ready: false, reason: "the deployment supplies no cloud compute" };
  if (!(await store.getHostedProvisioning(accountId)).enabled) return { ready: false, reason: "unattended provisioning is disabled" };
  const managed = new Set((await store.getEphemeralConfigs(accountId)).filter((c) => c.computeSource === "managed").map((c) => c.id));
  const configId = routedManagedConfigId(await store.getQueueRouting(accountId), managed);
  if (!configId) return { ready: false, reason: "automation routing has no cloud destination" };
  return { ready: true, reason: "cloud computer execution is ready", configId };
}

/**
 * When the account's automation routing points at the deployment's cloud
 * (as primary, or as fallback while the chosen machine is offline), move the
 * queued work waiting on that route to the cloud computer's own label. Returns
 * whether the cloud computer is now needed.
 */
export async function routeWorkToCloudComputer(
  store: Pick<EphemeralConfigurationRepository, "getQueueRouting" | "getEphemeralConfigs"> & Pick<NodeRepository, "listNodes"> & Pick<WorkQueueRepository, "listWorkItems" | "assignWorkItem">,
  accountId: string,
): Promise<boolean> {
  const routing = await store.getQueueRouting(accountId);
  const clouds = new Set((await store.getEphemeralConfigs(accountId)).filter((c) => c.computeSource === "managed").map((c) => c.id));
  let needed = false;
  if (routing.primary.kind === "config") needed = clouds.has(routing.primary.configId);
  else if (routing.primary.kind === "node" && routing.fallback && clouds.has(routing.fallback.configId)) {
    const primaryNode = routing.primary.node;
    needed = !(await store.listNodes(accountId)).some((n) => (n.name || n.id) === primaryNode && n.online);
  }
  if (!needed) return false;
  const sourceLabel = routing.primary.kind === "node" ? `bivy/${routing.primary.node}` : "bivy";
  const targetLabel = `bivy/${ephemeralNodeLabel(cloudComputerNodeId(accountId))}`;
  const pending = (await store.listWorkItems(accountId, 100)).filter((item) => item.status === "pending" && item.label === sourceLabel);
  for (const item of pending) {
    await store.assignWorkItem(accountId, item.id, { label: targetLabel, runtimeId: item.runtimeId, model: item.model, ephemeral: true });
  }
  return pending.length > 0 || (await store.listWorkItems(accountId, 100)).some((item) => item.status === "pending" && item.label === targetLabel);
}
