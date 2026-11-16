// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Why a turn ended short of a normal answer, when the agent says so: the model
 * declined, hit its output limit, or the agent hit its own request limit. The
 * turn itself succeeded, so nothing else in the chat explains a missing or
 * cut-off reply. Every runtime reports its agent's raw stop reason here and
 * gets the same notice, whatever the agent calls it.
 */
export type TurnStopReason = "refusal" | "max_tokens" | "max_turn_requests";

/** Raw stop reasons as agents and providers spell them. A plain end of turn,
 *  a tool call or a user cancel has no row: those need no notice. */
const STOP_REASONS: Record<string, TurnStopReason> = {
  refusal: "refusal",                     // ACP, Anthropic
  content_filter: "refusal",              // OpenAI-compatible providers
  max_tokens: "max_tokens",               // ACP, Anthropic
  length: "max_tokens",                   // Pi, OpenAI-compatible providers
  max_turn_requests: "max_turn_requests", // ACP
};

const NOTICES: Record<TurnStopReason, string> = {
  refusal: "The model declined to answer this request.",
  max_tokens: "The reply was cut off at the model's output limit. Send \"continue\" to pick up where it stopped.",
  max_turn_requests: "The agent stopped at its limit of model requests for this turn. Send a message to keep going.",
};

export function turnStopReason(raw: unknown): TurnStopReason | undefined {
  return typeof raw === "string" && Object.hasOwn(STOP_REASONS, raw) ? STOP_REASONS[raw] : undefined;
}

/** The notice for a turn's raw stop reason, or undefined when it needs none. */
export function stopReasonNotice(raw: unknown): { type: "session.notice"; level: "warning"; message: string } | undefined {
  const reason = turnStopReason(raw);
  return reason ? { type: "session.notice", level: "warning", message: NOTICES[reason] } : undefined;
}
