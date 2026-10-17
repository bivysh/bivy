// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Runners: disposable deployment-run machines, one per piece of work, beside
// the account's cloud computer, so queued work runs in parallel instead of in
// line on one machine. The deployment extension owns the fleet; Core owns each
// runner's node identity and boot payload, places work on it, and forgets the
// node when the deployment reports the machine gone.
//
// A runner is a normal enrolled node with its own room key, generated on its
// own disk. So it can run only work it can read: work whose instructions the
// node fetches itself (an issue, a comment, a CI failure). Work sealed to
// another node's key stays with that node.
import { createHash } from "node:crypto";
import { ephemeralNodeLabel, flyMachineBoot, type BootstrapOpts } from "@bivy/core";
import { cloudRouteSourceLabel, githubBootIdentity, type CloudComputerBoot } from "./cloud-computer.js";
import type { CentralGithubAppRepository, EphemeralConfigurationRepository, HostedMachineRepository, NodeRepository, WorkQueueRepository } from "./store.js";

const RUNNER_NODE = /^eph-runner-[0-9a-f]{16}$/;

/** Stable per piece of work, so a retried launch boots the same node. */
export function runnerNodeId(accountId: string, runnerId: string): string {
  return `eph-runner-${createHash("sha256").update(`${accountId}:${runnerId}`).digest("hex").slice(0, 16)}`;
}

export function isRunnerNode(nodeId: string | null | undefined): boolean {
  return Boolean(nodeId) && RUNNER_NODE.test(nodeId!);
}

/** The label work is placed on for a runner; also its node name. */
export function runnerLabel(nodeId: string): string {
  return ephemeralNodeLabel(nodeId);
}

export interface RunnerBootInput {
  accountId: string;
  runnerId: string;
  /** Upper bound on the runner's life; it ends itself once its work is done. */
  awakeCapMinutes: number;
  relayUrl: string;
  controlPlaneUrl: string;
}

/** Enroll a runner's node and build its Fly boot payload. Like the cloud
 * computer's, it carries no room key: the runner mints its own on its disk. */
export async function bootRunner(
  store: Pick<NodeRepository, "enrollNode"> & Pick<HostedMachineRepository, "getHostedProvisioning"> & Pick<CentralGithubAppRepository, "listCentralGithubInstallations">,
  input: RunnerBootInput,
): Promise<CloudComputerBoot> {
  const nodeId = runnerNodeId(input.accountId, input.runnerId);
  const label = runnerLabel(nodeId);
  const { enrollmentToken } = await store.enrollNode(input.accountId, nodeId, label);
  const bootstrap: BootstrapOpts = {
    relayUrl: input.relayUrl,
    controlPlaneUrl: input.controlPlaneUrl,
    enrollmentToken,
    ttlMinutes: input.awakeCapMinutes,
    provider: "fly",
    runner: true,
    // Ends shortly after its work finishes; the deployment then deletes it.
    teardownOnAgentFinish: true,
    hostedTasks: true,
    nodeLabel: label,
    ...await githubBootIdentity(store, input.accountId),
  };
  return { nodeId, ...flyMachineBoot(bootstrap) };
}

/** Work a runner can do: not sealed to another node's key, and not the
 * continuation of a session another node holds (its snapshot is sealed too). */
export function runnerCanRun(item: { body?: string; targetKind?: string }): boolean {
  return !item.body?.startsWith("bivy-room-v1:") && item.targetKind !== "existing_session";
}

export type LaunchRunner = (runnerId: string) => Promise<{ allowed: boolean }>;

/**
 * Place one queued item on a new runner when the account's routing sends work
 * to the cloud: label it for the runner, then ask the deployment for the
 * machine. Returns false (and puts the item back) when the item isn't for the
 * cloud, a runner can't read it, or the deployment refuses or fails, so the
 * caller can fall back to the cloud computer.
 */
export async function placeWorkOnRunner(
  store: Pick<EphemeralConfigurationRepository, "getQueueRouting" | "getEphemeralConfigs"> & Pick<NodeRepository, "listNodes"> & Pick<WorkQueueRepository, "listWorkItems" | "assignWorkItem">,
  accountId: string,
  itemId: string,
  launch: LaunchRunner,
): Promise<boolean> {
  const sourceLabel = await cloudRouteSourceLabel(store, accountId);
  if (sourceLabel === undefined) return false;
  const item = (await store.listWorkItems(accountId, 100)).find((i) => i.id === itemId);
  if (!item || item.status !== "pending" || item.label !== sourceLabel || !runnerCanRun(item)) return false;
  const runnerId = `work:${item.id}`;
  const routing = { runtimeId: item.runtimeId, model: item.model };
  await store.assignWorkItem(accountId, item.id, { ...routing, ephemeral: true, label: `bivy/${runnerLabel(runnerNodeId(accountId, runnerId))}` });
  const launched = await launch(runnerId).catch((error) => {
    console.warn(`[runners] launch for ${item.id} failed:`, error instanceof Error ? error.message : error);
    return { allowed: false };
  });
  if (launched.allowed) return true;
  await store.assignWorkItem(accountId, item.id, { ...routing, ephemeral: item.ephemeral, label: sourceLabel });
  return false;
}
