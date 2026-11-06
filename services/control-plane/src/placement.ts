// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Where queued work the account routes to the cloud runs. One table of rules,
// read top to bottom: the first row whose `when` holds decides. Adding a case
// means adding a row. The facts are gathered once (cloudWorkFacts); acting on
// the decision is the caller's (placeCloudWork).
//
// Places:
// - "own-runner": the sleeping runner the session already lives on; wake it.
// - "new-runner": a new runner, restoring the session first when it continues
//   one (its snapshot must be sealed to the account, see src/session/seal-keys.ts
//   on the node).
// - "computer": the account's cloud computer.
// - "wait": nothing in the cloud can run it; it stays queued for the account's
//   own machines.

import { ACCOUNT_SEAL_PREFIX } from "@bivy/core";
import { cloudRouteSourceLabel, isCloudComputerNode } from "./cloud-computer.js";
import { isRunnerNode, runnerLabel, runnerNodeId } from "./runners.js";
import type { EphemeralConfigurationRepository, NodeRepository, SessionIndexRepository, SessionStateRepository, WorkQueueRepository } from "./store.js";

export interface CloudWorkFacts {
  offer: { computer: boolean; runners: boolean };
  /** Instructions sealed to one machine's key: only that machine can read them. */
  sealedToMachine: boolean;
  /** The work continues an existing session. */
  continues?: {
    sessionId: string;
    /** The session lives on the account's cloud computer. */
    onComputer: boolean;
    /** The runner the session lives on, when that runner still exists. */
    runnerNodeId?: string;
    /** Its snapshot is sealed to the account, so a new machine can restore it. */
    restorable: boolean;
  };
}

export type CloudPlacement =
  | { to: "own-runner"; nodeId: string }
  | { to: "new-runner"; restoreSessionId?: string }
  | { to: "computer" }
  | { to: "wait" };

const computerOrWait = (facts: CloudWorkFacts): CloudPlacement => (facts.offer.computer ? { to: "computer" } : { to: "wait" });

export const PLACEMENT_RULES: Array<{ why: string; when: (facts: CloudWorkFacts) => boolean; place: (facts: CloudWorkFacts) => CloudPlacement }> = [
  { why: "sealed to one machine's key: only the cloud computer can read it",
    when: (f) => f.sealedToMachine, place: computerOrWait },
  { why: "continues a session on the cloud computer",
    when: (f) => Boolean(f.continues?.onComputer && f.offer.computer), place: () => ({ to: "computer" }) },
  { why: "continues a session on a runner that still exists: wake it",
    when: (f) => Boolean(f.continues?.runnerNodeId && f.offer.runners), place: (f) => ({ to: "own-runner", nodeId: f.continues!.runnerNodeId! }) },
  { why: "continues a session whose machine is gone: restore it on a new runner",
    when: (f) => Boolean(f.continues?.restorable && f.offer.runners), place: (f) => ({ to: "new-runner", restoreSessionId: f.continues!.sessionId }) },
  { why: "continues a session no runner can restore",
    when: (f) => Boolean(f.continues), place: computerOrWait },
  { why: "new work: its own runner",
    when: (f) => f.offer.runners, place: () => ({ to: "new-runner" }) },
  { why: "new work, no runners",
    when: () => true, place: computerOrWait },
];

export function placeFor(facts: CloudWorkFacts): CloudPlacement {
  return PLACEMENT_RULES.find((rule) => rule.when(facts))!.place(facts);
}

type FactStore = Pick<NodeRepository, "listNodes"> & Pick<SessionIndexRepository, "listAccountSessions"> & Pick<SessionStateRepository, "getSessionSnapshot">;

export async function cloudWorkFacts(
  store: FactStore,
  accountId: string,
  item: { body?: string; targetKind?: string; targetSessionId?: string },
  offer: CloudWorkFacts["offer"],
): Promise<CloudWorkFacts> {
  const facts: CloudWorkFacts = { offer, sealedToMachine: Boolean(item.body?.startsWith("bivy-room-v1:")) };
  if (item.targetKind !== "existing_session" || !item.targetSessionId) return facts;
  const sessionId = item.targetSessionId;
  const [sessions, nodes, snapshot] = await Promise.all([
    store.listAccountSessions(accountId),
    store.listNodes(accountId),
    store.getSessionSnapshot(accountId, sessionId),
  ]);
  const home = sessions.find((session) => session.sessionId === sessionId)?.nodeId;
  const runnerExists = Boolean(home && isRunnerNode(home) && nodes.some((node) => node.id === home));
  facts.continues = {
    sessionId,
    onComputer: Boolean(home && isCloudComputerNode(accountId, home)),
    ...(runnerExists ? { runnerNodeId: home } : {}),
    restorable: Boolean(snapshot?.ciphertext.startsWith(ACCOUNT_SEAL_PREFIX)),
  };
  return facts;
}

export interface PlacementActions {
  /** Start a runner for `runnerId`, restoring `restoreSessionId` first if given. */
  launchRunner(runnerId: string, restoreSessionId?: string): Promise<{ allowed: boolean }>;
  /** Wake a sleeping runner. */
  wakeRunner(nodeId: string): Promise<{ allowed: boolean }>;
}

/**
 * Place one queued item the account's routing sends to the cloud. Runner
 * placements label the item for that runner and start or wake it; if that
 * fails the item goes back where it was. Returns where it went, "computer"
 * for the caller to hand to the cloud computer, or undefined when the item
 * isn't (or is no longer) cloud work.
 */
export async function placeCloudWork(
  store: FactStore & Pick<EphemeralConfigurationRepository, "getQueueRouting" | "getEphemeralConfigs"> & Pick<WorkQueueRepository, "listWorkItems" | "assignWorkItem">,
  accountId: string,
  itemId: string,
  offer: CloudWorkFacts["offer"],
  actions: PlacementActions,
): Promise<CloudPlacement["to"] | undefined> {
  const sourceLabel = await cloudRouteSourceLabel(store, accountId);
  if (sourceLabel === undefined) return undefined;
  const item = (await store.listWorkItems(accountId, 100)).find((candidate) => candidate.id === itemId);
  if (!item || item.status !== "pending" || item.label !== sourceLabel) return undefined;
  const placement = placeFor(await cloudWorkFacts(store, accountId, item, offer));
  if (placement.to === "computer" || placement.to === "wait") return placement.to;
  const routing = { runtimeId: item.runtimeId, model: item.model };
  const runnerId = `work:${item.id}`;
  const nodeId = placement.to === "own-runner" ? placement.nodeId : runnerNodeId(accountId, runnerId);
  await store.assignWorkItem(accountId, item.id, { ...routing, ephemeral: true, label: `bivy/${runnerLabel(nodeId)}` });
  const started = await (placement.to === "own-runner" ? actions.wakeRunner(nodeId) : actions.launchRunner(runnerId, placement.restoreSessionId))
    .catch((error) => {
      console.warn(`[placement] ${placement.to} for ${item.id} failed:`, error instanceof Error ? error.message : error);
      return { allowed: false };
    });
  if (started.allowed) return placement.to;
  await store.assignWorkItem(accountId, item.id, { ...routing, ephemeral: item.ephemeral, label: sourceLabel });
  return offer.computer ? "computer" : "wait";
}

