// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeEvent } from "./types.js";

/**
 * The agent is summarizing its own conversation to free up context, on its own
 * when the window fills or because the user ran /compact. That can take a
 * minute with nothing else streaming, and afterwards the agent works from a
 * summary instead of the full history. Every runtime reports it in this one
 * shape, `agent_compaction`, so clients show the same "Compacting the
 * conversation…" status for any agent, and the chat says once it is done.
 */
export interface AgentCompaction {
  /** A compaction that has just finished (or failed). */
  done?: unknown;
  /** Why it ran, as the agent says it: `auto`, `manual`, Pi's `threshold`, … */
  trigger?: unknown;
  /** Context tokens before and after, when the agent reports them. */
  tokensBefore?: unknown;
  tokensAfter?: unknown;
  /** Why a compaction failed. */
  error?: unknown;
  /** Stopped before it finished (the user stopped the turn): no notice. */
  cancelled?: unknown;
}

export type CompactionTrigger = "auto" | "manual";

/** Triggers as agents spell them. Anything else reads as automatic. */
const TRIGGERS: Record<string, CompactionTrigger> = {
  manual: "manual",     // Claude, Pi
  auto: "auto",         // Claude
  threshold: "auto",    // Pi: the window passed its compaction threshold
  overflow: "auto",     // Pi: the provider refused an over-long request
};

const tokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);

/** 148_000 → "148k", 1_200_000 → "1.2M": the size, not the exact count. */
function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function doneMessage(trigger: CompactionTrigger | undefined, before?: number, after?: number): string {
  const lead = trigger === "auto"
    ? "The conversation filled the context window, so the agent summarized it"
    : "The agent summarized the conversation";
  // Some agents report the same count before and after (nothing was dropped);
  // a drop is the only figure worth showing.
  const size = before && after && after < before
    ? ` (${shortTokens(before)} → ${shortTokens(after)} tokens)`
    : "";
  return `${lead}${size}. It continues from that summary, so it may not recall every earlier detail.`;
}

/**
 * The events for one compaction step: the status while it runs, and on
 * completion the status cleared plus one chat notice saying what happened.
 */
export function agentCompactionEvents(compaction: AgentCompaction): RuntimeEvent[] {
  const raw = typeof compaction.trigger === "string" ? compaction.trigger.trim().toLowerCase() : "";
  const trigger = raw ? TRIGGERS[raw] ?? "auto" : undefined;
  const ended = compaction.done === true || compaction.cancelled === true;
  const status: RuntimeEvent = { type: "agent_compaction", ...(ended ? { done: true } : {}), ...(trigger ? { trigger } : {}) };
  if (!ended || compaction.cancelled === true) return [status];
  const error = typeof compaction.error === "string" ? compaction.error.trim() : "";
  const notice: RuntimeEvent = error
    ? { type: "session.notice", level: "warning", message: `The agent couldn't summarize the conversation: ${error.replace(/[.\s]+$/, "")}.` }
    : { type: "session.notice", level: "info", message: doneMessage(trigger, tokens(compaction.tokensBefore), tokens(compaction.tokensAfter)) };
  return [status, notice];
}
