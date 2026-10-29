// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/** A message from Bivy in the chat, such as which automations were applied. Mirrors
 *  src/session/notices.ts; the block string MUST match there. */
export interface AgentNotice {
  id: string;
  text: string;
  urgent?: boolean;
}

export const NOTICE_BLOCK = "bivy_notice";

export function isAgentNotice(value: unknown): value is AgentNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<AgentNotice>;
  return typeof n.id === "string" && n.id.length > 0 && typeof n.text === "string" && n.text.length > 0
    && (n.urgent === undefined || typeof n.urgent === "boolean");
}

/** An instant in the viewer's local time: just the clock when it's today, with
 *  the weekday when it's further out (a weekly limit). Null when unparseable. */
export function formatLocalClock(iso: string, now: number = Date.now()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const today = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** A session notice's text. A notice may carry an instant (`at`) and a
 *  `localMessage` with a `{time}` slot, so each viewer reads it in their own
 *  time zone; `message` is the node's fallback for clients that predate this. */
export function noticeText(notice: { message?: unknown; localMessage?: unknown; at?: unknown }, now: number = Date.now()): string {
  const fallback = String(notice.message ?? "");
  if (typeof notice.localMessage !== "string" || !notice.localMessage.includes("{time}") || typeof notice.at !== "string") return fallback;
  const time = formatLocalClock(notice.at, now);
  return time ? notice.localMessage.replace("{time}", time) : fallback;
}
