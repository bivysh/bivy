// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * A message the agent sends the user with `bivy notify`: a card in the chat,
 * and a push to their devices when nobody has the app open (or it is urgent).
 * The push names the session only; the text stays in the chat. Mirrored in
 * packages/core/src/notices.ts; the block string MUST match there.
 */
export interface AgentNotice {
  id: string;
  text: string;
  /** Pushed even while the user has the app open. */
  urgent?: boolean;
}

export const NOTICE_BLOCK = "bivy_notice";
export const MAX_NOTICE_TEXT = 2000;

/** At most one push per session in this window; later notices still post a card. */
export const NOTICE_PUSH_GAP_MS = 60_000;

export type NoticePush = "sent" | "user_watching" | "rate_limited" | "unavailable";

/** Whether a notice also buzzes the user's devices. `pushConfigured` is false on
 *  a node with no account connection, which has no way to push. */
export function noticePush(input: { urgent?: boolean; userWatching: boolean; lastPushAt?: number; now: number; pushConfigured?: boolean }): NoticePush {
  if (input.pushConfigured === false) return "unavailable";
  if (input.lastPushAt !== undefined && input.now - input.lastPushAt < NOTICE_PUSH_GAP_MS) return "rate_limited";
  if (input.userWatching && !input.urgent) return "user_watching";
  return "sent";
}

export function isAgentNotice(value: unknown): value is AgentNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<AgentNotice>;
  return typeof n.id === "string" && n.id.length > 0
    && typeof n.text === "string" && n.text.length > 0 && n.text.length <= MAX_NOTICE_TEXT
    && (n.urgent === undefined || typeof n.urgent === "boolean");
}
