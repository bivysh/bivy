// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Delegated child sessions (`bivy delegate`) sit directly under their parent
 * when the parent is in the same list, instead of as unrelated top-level rows.
 * A child whose parent isn't listed (another machine, filtered out) keeps its
 * own place. Order is otherwise preserved.
 */
export function nestDelegatedSessions<T extends { sessionId: string; delegatedFrom?: { sessionId: string } }>(rows: readonly T[]): Array<T & { nestedUnder?: string }> {
  const listed = new Set(rows.map((row) => row.sessionId));
  const children = new Map<string, T[]>();
  const top: T[] = [];
  for (const row of rows) {
    const parent = row.delegatedFrom?.sessionId;
    if (parent && parent !== row.sessionId && listed.has(parent)) children.set(parent, [...(children.get(parent) ?? []), row]);
    else top.push(row);
  }
  return top.flatMap((row) => [row, ...(children.get(row.sessionId) ?? []).map((child) => ({ ...child, nestedUnder: row.sessionId }))]);
}
