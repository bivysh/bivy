// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * A task the agent proposes with `bivy suggest`: the user can start it with
 * one tap, here or in a parallel session. Mirrored in packages/core/src/
 * suggestions.ts; the block string MUST match there.
 */
export interface TaskSuggestion {
  id: string;
  /** The complete instruction, sent as the prompt when the user starts it. */
  text: string;
  /** A short label; the card falls back to the text. */
  title?: string;
  /** Where the agent recommends running it: the card's primary action. */
  run?: SuggestionRun;
}

/** here: this session's agent. subagents: this agent, through its own sub-agents. new: a session per task. */
export const SUGGESTION_RUNS = ["here", "subagents", "new"] as const;
export type SuggestionRun = typeof SUGGESTION_RUNS[number];
const isRun = (value: unknown) => value === undefined || (SUGGESTION_RUNS as readonly unknown[]).includes(value);

export const SUGGESTION_BLOCK = "bivy_suggestion";
export const MAX_SUGGESTION_TEXT = 4000;
export const MAX_SUGGESTION_TITLE = 120;

export function isTaskSuggestion(value: unknown): value is TaskSuggestion {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<TaskSuggestion>;
  return typeof s.id === "string" && s.id.length > 0
    && typeof s.text === "string" && s.text.length > 0 && s.text.length <= MAX_SUGGESTION_TEXT
    && (s.title === undefined || (typeof s.title === "string" && s.title.length <= MAX_SUGGESTION_TITLE))
    && isRun(s.run);
}
