// SPDX-License-Identifier: AGPL-3.0-only
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
