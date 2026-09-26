// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// "Show in chat" from the Artifacts and Apps pages: open a session and land on
// the message that carries a given file or app. Transcript entry ids are minted
// per render (store-render's nextId), so a jump names content — an attachment
// hash or an app id — and ChatView resolves it once the history has arrived.

import type { TranscriptEntry } from "@bivy/core";

export type MessageTarget = { hash: string } | { appId: string } | { reviewId: string };

/** A jump that hasn't resolved by then (another machine never connected, the
 *  history never loaded, or the message was rewound away) is dropped rather
 *  than firing much later. */
const JUMP_TTL_MS = 30_000;

let pending: { sessionId: string; target: MessageTarget; at: number } | null = null;

export function requestMessageJump(sessionId: string, target: MessageTarget): void {
  pending = { sessionId, target, at: Date.now() };
}

const matches = (entry: TranscriptEntry, target: MessageTarget): boolean =>
  "hash" in target ? Boolean(entry.attachments?.some((attachment) => attachment.hash === target.hash))
    : "reviewId" in target ? entry.review?.id === target.reviewId
    : entry.app?.appId === target.appId;

/** The pending jump's entry index for this session, once it is present. The
 *  latest message wins for a file sent more than once, matching the index. */
export function pendingJumpIndex(sessionId: string | null, entries: readonly TranscriptEntry[]): number | null {
  if (!pending || pending.sessionId !== sessionId) return null;
  if (Date.now() - pending.at > JUMP_TTL_MS) { pending = null; return null; }
  const { target } = pending;
  const index = entries.findLastIndex((entry) => matches(entry, target));
  return index >= 0 ? index : null;
}

export function clearMessageJump(): void {
  pending = null;
}
