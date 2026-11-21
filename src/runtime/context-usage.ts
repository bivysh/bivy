// How full a session's context window is, as every agent reports it in its own
// words: Claude's getContextUsage (totalTokens/maxTokens), Pi's
// getContextUsage (tokens/contextWindow), Codex's thread/tokenUsage/updated
// (last turn's totalTokens / modelContextWindow) and ACP's usage_update
// (used/size). Each adapter hands its pair here; the rest of Bivy sees one
// `UsageSnapshot.context` shape.

import type { UsageSnapshot } from "./types.js";

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** `{ used, size }` from a raw pair, or undefined when either is missing or the window is empty. */
export function contextUsage(raw: unknown): UsageSnapshot["context"] {
  if (!raw || typeof raw !== "object") return undefined;
  const { used, size } = raw as Record<string, unknown>;
  const u = count(used);
  const s = count(size);
  return u !== undefined && s ? { used: u, size: s } : undefined;
}
