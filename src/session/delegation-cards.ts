// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure: fold a delegated Run's latest status into its card in the parent
// session (docs/agent-delegation.md). The server logs and broadcasts the result.

import type { SafeRunResult } from "../run-tools.js";
import { MAX_DELEGATION_ANSWER, MAX_DELEGATION_TASK, type DelegationCard } from "./delegations.js";

/** What only the start request knows: the task, target and fan-out group. */
export interface DelegationStart {
  instructions: string;
  agent?: string;
  machine?: string;
  nodeId?: string;
  group?: string;
}

const bound = (value: string | undefined, max: number) =>
  value && value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function delegationCard(prev: DelegationCard | undefined, run: SafeRunResult, start?: DelegationStart): DelegationCard {
  const refs = run.references ?? {};
  const task = start ? bound(start.instructions.trim().split(/\r?\n/, 1)[0] ?? "", MAX_DELEGATION_TASK)! : prev?.task ?? "";
  const pick = <K extends keyof DelegationCard>(key: K, next: DelegationCard[K] | undefined) => (next ?? prev?.[key]) as DelegationCard[K] | undefined;
  const card: DelegationCard = { id: run.runId, status: run.status, task };
  const fields: Partial<DelegationCard> = {
    agent: pick("agent", start?.agent),
    machine: pick("machine", start?.machine),
    nodeId: pick("nodeId", start?.nodeId),
    group: pick("group", start?.group),
    childSessionId: pick("childSessionId", refs.sessionId),
    answer: pick("answer", bound(run.answer, MAX_DELEGATION_ANSWER)),
    branch: pick("branch", refs.branch),
    prUrl: pick("prUrl", refs.prUrl),
    failure: pick("failure", refs.failure),
  };
  for (const [key, value] of Object.entries(fields)) if (value) (card as unknown as Record<string, unknown>)[key] = value;
  return card;
}
