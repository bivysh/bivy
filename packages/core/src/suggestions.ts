// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** A task the agent proposed with `bivy suggest`. Mirrors
 *  src/session/suggestions.ts; the block string MUST match there. */
export interface TaskSuggestion {
  id: string;
  /** The complete instruction, sent as the prompt when the user starts it. */
  text: string;
  /** A short label; the card falls back to the text. */
  title?: string;
}

export const SUGGESTION_BLOCK = "bivy_suggestion";

export function isTaskSuggestion(value: unknown): value is TaskSuggestion {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<TaskSuggestion>;
  return typeof s.id === "string" && s.id.length > 0 && typeof s.text === "string" && s.text.length > 0
    && (s.title === undefined || typeof s.title === "string");
}
