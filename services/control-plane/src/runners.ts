// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Runners: deployment-run machines, one per session or piece of work, with or
// without the account's cloud computer, so work runs in parallel instead of in
// line on one machine. A runner sleeps once its work is done and keeps the
// session, so nothing someone can see disappears when the work ends. The
// deployment extension owns the fleet; Core owns each runner's node identity
// and boot payload, places work on it, and forgets the node when the
// deployment reports the machine gone.
//
// A runner is a normal enrolled node with its own room key, generated on its
// own disk. So it can run only work it can read: work whose instructions the
// node fetches itself (an issue, a comment, a CI failure). Work sealed to
// another node's key stays with that node.
import { createHash } from "node:crypto";
import { ephemeralNodeLabel, flyMachineBoot, type BootstrapOpts } from "@bivy/core";
import { githubBootIdentity, type CloudComputerBoot } from "./cloud-computer.js";
import type { CentralGithubAppRepository, HostedMachineRepository, NodeRepository } from "./store.js";

const RUNNER_NODE = /^eph-runner-[0-9a-f]{16}$/;

/** Stable per piece of work, so a retried launch boots the same node. */
export function runnerNodeId(accountId: string, runnerId: string): string {
  return `eph-runner-${createHash("sha256").update(`${accountId}:${runnerId}`).digest("hex").slice(0, 16)}`;
}

export function isRunnerNode(nodeId: string | null | undefined): boolean {
  return Boolean(nodeId) && RUNNER_NODE.test(nodeId!);
}

/** A runner someone started for a new session, rather than for queued work.
 * It sleeps when idle and wakes for the session's follow-ups, like the cloud
 * computer; the deployment deletes it once it has slept long enough. */
export function sessionRunnerId(requestId: string): string {
  return `session:${requestId}`;
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
  /** A session to restore from its account-sealed snapshot. */
  restoreSessionId?: string;
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
    nodeId,
    ttlMinutes: input.awakeCapMinutes,
    provider: "fly",
    runner: true,
    // Every runner sleeps once idle and keeps its disk: the session it ran
    // stays there to open, continue or delete.
    sleepOnIdle: true,
    hostedTasks: true,
    restoreSessionId: input.restoreSessionId,
    nodeLabel: label,
    ...await githubBootIdentity(store, input.accountId),
  };
  return { nodeId, ...flyMachineBoot(bootstrap) };
}
