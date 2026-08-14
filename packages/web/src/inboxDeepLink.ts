// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Resolve where an inbox item / push tap should land, and what exact element to
// focus once there (B3). Shared by the in-app Inbox click and the push
// deep-link, so both focus the SAME exact approval/question/outcome instead of
// dumping the user at the session top. Pure — unit-tested without a DOM.

import type { InboxItem } from "@bivy/core";

export interface InboxDeepLink {
  target: "session" | "settings";
  sessionId?: string;
  nodeId?: string;
  /** Settings tab to open when the item isn't session-scoped. */
  settingsTab?: "queue" | "providers";
  /** The `attention-<id>` element to scroll to / focus after navigating, for a
   *  session-scoped approval, question, or outcome. Undefined = no exact anchor,
   *  just open the destination. */
  attentionId?: string;
}

/** Kinds that have a focusable card/anchor within a session view. */
const FOCUSABLE = new Set(["approval", "question", "outcome"]);

export function resolveInboxDeepLink(item: InboxItem): InboxDeepLink {
  if (item.sessionId) {
    return {
      target: "session",
      sessionId: item.sessionId,
      nodeId: item.nodeId,
      attentionId: FOCUSABLE.has(item.kind) && item.targetId ? item.targetId : undefined,
    };
  }
  if (item.source === "queue") return { target: "settings", settingsTab: "queue" };
  if (item.source === "provider") return { target: "settings", settingsTab: "providers" };
  // Automation/other non-session items still route to the queue view, their home.
  return { target: "settings", settingsTab: "queue" };
}

/** Build the URL query deep-link for a push notification so a cold open focuses
 *  the same exact target (`?attention=<id>` is read on app mount). */
export function inboxDeepLinkQuery(item: InboxItem): string {
  const link = resolveInboxDeepLink(item);
  const params = new URLSearchParams();
  if (link.sessionId) params.set("session", link.sessionId);
  if (link.attentionId) params.set("attention", link.attentionId);
  if (link.settingsTab) params.set("settings", link.settingsTab);
  const q = params.toString();
  return q ? `/?${q}` : "/";
}
