// SPDX-License-Identifier: MIT
export interface ChatScrollMemory {
  distanceFromBottom: number;
  pinned: boolean;
  limit: number;
}

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function captureChatScroll(metrics: ScrollMetrics, pinned: boolean, limit: number): ChatScrollMemory {
  return {
    distanceFromBottom: Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight),
    pinned,
    limit,
  };
}

export function restoredChatScrollTop(metrics: ScrollMetrics, memory?: ChatScrollMemory): number {
  if (!memory || memory.pinned) return metrics.scrollHeight;
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - memory.distanceFromBottom);
}

/** Where "↑ Prompt" scrolls: the start of the nearest prompt above the top of
 *  the view, `inset` px below the edge, so a repeated tap steps further back.
 *  With no prompt above, the top of what is loaded (where "Show earlier" is). */
export function previousPromptTop(promptTops: readonly number[], scrollTop: number, inset = 12): number {
  const above = promptTops.map((top) => top - inset).filter((top) => top < scrollTop - 1);
  return Math.max(0, above.length ? Math.max(...above) : 0);
}
