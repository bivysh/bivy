// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Follow-up queue as immutable data. Commands are values; reducing a command
// returns a new queue plus an explicit outcome and performs no storage, clock,
// transport, automation, or notification effects.

import type { PromptAttachment } from "./protocol.js";

export type FollowupStatus = "queued" | "scheduled" | "sending" | "sent" | "failed";

export interface PendingFollowup {
  id: string;
  text: string;
  attachments?: PromptAttachment[];
  status: FollowupStatus;
  createdAt: number;
  updatedAt: number;
  version: number;
  scheduledAt?: number;
  scheduledAutomationId?: string;
}

export type FollowupEditResult =
  | { ok: true; item: PendingFollowup }
  | { ok: false; reason: "not_found" | "stale" | "not_queued" };

export type FollowupQueueCommand =
  | { type: "enqueue"; item: { id: string; text: string; attachments?: PromptAttachment[]; scheduledAutomationId?: string }; now: number }
  | { type: "schedule"; item: { id: string; text: string; scheduledAt: number; scheduledAutomationId: string }; now: number }
  | { type: "attach-automation"; id: string; automationId: string }
  | { type: "edit"; id: string; patch: { text: string; attachments?: PromptAttachment[] }; expectedVersion: number; now: number }
  | { type: "remove"; id: string }
  | { type: "prune-scheduled"; keepIds: ReadonlySet<string> }
  | { type: "reschedule"; id: string; scheduledAt: number; now: number }
  | { type: "reorder"; id: string; toIndex: number }
  | { type: "mark-sending"; id: string; now: number }
  | { type: "confirm-sent"; id: string }
  | { type: "revert-to-queued"; id: string; now: number }
  | { type: "settle-sending" }
  | { type: "clear" };

export interface FollowupQueueTransition {
  queue: readonly PendingFollowup[];
  changed: boolean;
  accepted?: boolean;
  item?: PendingFollowup;
  edit?: FollowupEditResult;
}

function unchanged(queue: readonly PendingFollowup[], accepted = false): FollowupQueueTransition {
  return { queue, changed: false, accepted };
}

export function reduceFollowupQueue(
  queue: readonly PendingFollowup[],
  command: FollowupQueueCommand,
): FollowupQueueTransition {
  switch (command.type) {
    case "enqueue": {
      const existing = queue.find((item) => item.id === command.item.id);
      if (existing) return { ...unchanged(queue, true), item: existing };
      const item: PendingFollowup = {
        ...command.item,
        status: "queued",
        createdAt: command.now,
        updatedAt: command.now,
        version: 1,
      };
      return { queue: [...queue, item], changed: true, accepted: true, item };
    }
    case "schedule": {
      const existing = queue.find((item) => item.id === command.item.id);
      if (existing) return { ...unchanged(queue, true), item: existing };
      const item: PendingFollowup = {
        ...command.item,
        status: "scheduled",
        createdAt: command.now,
        updatedAt: command.now,
        version: 1,
      };
      return { queue: [...queue, item], changed: true, accepted: true, item };
    }
    case "attach-automation": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0 || queue[index]!.status !== "queued") return unchanged(queue);
      const next = queue.slice();
      next[index] = { ...queue[index]!, scheduledAutomationId: command.automationId };
      return { queue: next, changed: true, accepted: true };
    }
    case "edit": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0) return { ...unchanged(queue), edit: { ok: false, reason: "not_found" } };
      const current = queue[index]!;
      if (current.status !== "queued") return { ...unchanged(queue), edit: { ok: false, reason: "not_queued" } };
      if (current.version !== command.expectedVersion) return { ...unchanged(queue), edit: { ok: false, reason: "stale" } };
      const item: PendingFollowup = {
        ...current,
        ...command.patch,
        version: current.version + 1,
        updatedAt: command.now,
        scheduledAutomationId: undefined,
      };
      const next = queue.slice();
      next[index] = item;
      return { queue: next, changed: true, accepted: true, item, edit: { ok: true, item } };
    }
    case "remove": {
      const item = queue.find((candidate) => candidate.id === command.id);
      if (!item || (item.status !== "queued" && item.status !== "scheduled")) return unchanged(queue);
      return { queue: queue.filter((candidate) => candidate.id !== command.id), changed: true, accepted: true };
    }
    case "prune-scheduled": {
      const next = queue.filter((item) => item.status !== "scheduled" || (item.scheduledAutomationId ? command.keepIds.has(item.scheduledAutomationId) : false));
      return next.length === queue.length ? unchanged(queue) : { queue: next, changed: true, accepted: true };
    }
    case "reschedule": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0 || queue[index]!.status !== "scheduled") return unchanged(queue);
      const next = queue.slice();
      next[index] = { ...queue[index]!, scheduledAt: command.scheduledAt, updatedAt: command.now, version: queue[index]!.version + 1 };
      return { queue: next, changed: true, accepted: true };
    }
    case "reorder": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0 || queue[index]!.status !== "queued") return unchanged(queue);
      const target = Math.max(0, Math.min(command.toIndex, queue.length - 1));
      if (target === index) return unchanged(queue, true);
      const next = queue.slice();
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return { queue: next, changed: true, accepted: true };
    }
    case "mark-sending": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0) return unchanged(queue);
      const item = { ...queue[index]!, status: "sending" as const, updatedAt: command.now };
      const next = queue.slice();
      next[index] = item;
      return { queue: next, changed: true, accepted: true, item };
    }
    case "confirm-sent": {
      if (!queue.some((item) => item.id === command.id)) return unchanged(queue);
      return { queue: queue.filter((item) => item.id !== command.id), changed: true, accepted: true };
    }
    case "revert-to-queued": {
      const index = queue.findIndex((item) => item.id === command.id);
      if (index < 0 || queue[index]!.status !== "sending") return unchanged(queue);
      const item: PendingFollowup = { ...queue[index]!, status: "queued", updatedAt: command.now };
      return { queue: [item, ...queue.filter((candidate) => candidate.id !== command.id)], changed: true, accepted: true, item };
    }
    case "settle-sending": {
      if (!queue.some((item) => item.status === "sending")) return unchanged(queue);
      return { queue: queue.filter((item) => item.status !== "sending"), changed: true, accepted: true };
    }
    case "clear":
      return queue.length ? { queue: [], changed: true, accepted: true } : unchanged(queue, true);
  }
}
