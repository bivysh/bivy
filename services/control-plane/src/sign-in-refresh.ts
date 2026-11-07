// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// When to start a refresh-only runner for an account whose cloud machines may
// start with its sign-ins: none of its machines (its own, its cloud computer,
// its runners) has been seen for `idleMs`, and no refresh run started in that
// time either. Any machine that runs refreshes what it uses, so an account
// that's in use never needs one.

export function signInRefreshDue(input: {
  now: number;
  idleMs: number;
  lastRefreshRunAt?: string;
  nodes: Array<{ online: boolean; lastSeenAt: string | null }>;
}): boolean {
  if (input.lastRefreshRunAt && input.now - Date.parse(input.lastRefreshRunAt) < input.idleMs) return false;
  if (input.nodes.some((node) => node.online)) return false;
  const lastSeen = Math.max(0, ...input.nodes.map((node) => Date.parse(node.lastSeenAt ?? "") || 0));
  return input.now - lastSeen >= input.idleMs;
}
