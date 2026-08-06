// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash } from "node:crypto";

/**
 * Incremental history sync.
 *
 * Clients cache the conversation transcript locally and, on reconnect or
 * re-open, ask the node for *only what's new* instead of the whole thing. Agent
 * messages are opaque (`RuntimeMessage = Record<string, unknown>`, no per-message
 * id), so the cursor is a simple **count + hash**:
 *
 *   - The node hashes the messages it sends and returns the hash as an opaque
 *     `historyHash` token. The client stores `{ count, historyHash }`.
 *   - On the next request the client echoes `have` (the count it holds) and
 *     `haveToken` (that token). The node recomputes the hash of its own first
 *     `have` messages; if it matches, the client's prefix is identical and the
 *     node sends only `messages.slice(have)` (mode "append"). Otherwise the
 *     transcript diverged (compaction/edit) or the client has nothing, so it
 *     sends everything (mode "full") — the self-healing resync path.
 *
 * The hash is ALWAYS computed node-side over the node's own messages, so there
 * is no cross-language/serialization agreement to maintain with clients.
 */

export type HistoryMode = "full" | "append";

export interface HistoryCursor {
  /** Number of leading messages the client already has cached. */
  have?: number;
  /** The `historyHash` token the node returned for those messages last time. */
  haveToken?: string;
}

export interface HistoryDelta {
  mode: HistoryMode;
  /** Index the returned `messages` begin at (0 for a full send). */
  baseCount: number;
  /** The messages to send: the full list, or just the new tail. */
  messages: unknown[];
  /** Total message count after the client applies this delta. */
  count: number;
  /** Opaque token over all `count` messages; the client stores and echoes it. */
  historyHash: string;
}

function hashMessages(messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

/**
 * Decide whether to send the whole transcript or just the new tail, given what
 * the client says it already has.
 */
export function historyDelta(messages: unknown[], cursor: HistoryCursor = {}): HistoryDelta {
  const count = messages.length;
  const historyHash = hashMessages(messages);
  const { have, haveToken } = cursor;
  if (
    typeof have === "number" &&
    Number.isInteger(have) &&
    have > 0 &&
    have <= count &&
    typeof haveToken === "string" &&
    haveToken.length > 0 &&
    hashMessages(messages.slice(0, have)) === haveToken
  ) {
    // Prefix matches — send only what's new (possibly nothing, if have === count).
    return { mode: "append", baseCount: have, messages: messages.slice(have), count, historyHash };
  }
  return { mode: "full", baseCount: 0, messages, count, historyHash };
}
