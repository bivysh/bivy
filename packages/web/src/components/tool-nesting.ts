// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ToolActivity } from "@bivy/core";

/** Order a group's tools so a sub-agent's steps sit directly beneath the
 *  delegation that spawned them, instead of flat and unlabelled among the
 *  parent's own calls. A child is any tool carrying a `parentToolUseId` that
 *  matches another tool's `callId` in the same group; children keep their
 *  original relative order under their parent.
 *
 *  Nesting is arbitrary-depth: a sub-agent that itself delegates (a grandchild
 *  tool call) is placed one level deeper than its parent rather than dropped —
 *  agents such as Claude Code spawn sub-agents that spawn sub-agents (its result
 *  event reports `max_depth`/`spawned_by_subagents`), and a depth-1-only walk
 *  would hide that deeper work entirely. Tools whose parent isn't in the group
 *  (orphans) stay top-level in place, and cycles / mutually-parented tools are
 *  emitted at depth 0 rather than vanishing, so the ordering NEVER hides work.
 *  Pure and React-free so it can be unit-tested directly. */
export function orderToolsWithDepth(tools: ToolActivity[]): { tool: ToolActivity; depth: number }[] {
  const byId = new Map(tools.map((t) => [t.callId, t] as const));
  const childrenOf = new Map<string, ToolActivity[]>();
  const isChild = (t: ToolActivity) => Boolean(t.parentToolUseId && t.parentToolUseId !== t.callId && byId.has(t.parentToolUseId));
  for (const t of tools) if (isChild(t)) {
    const list = childrenOf.get(t.parentToolUseId!) ?? [];
    list.push(t);
    childrenOf.set(t.parentToolUseId!, list);
  }
  const out: { tool: ToolActivity; depth: number }[] = [];
  const visited = new Set<string>();
  // Depth-first: emit a tool, then recurse into its children one level deeper.
  // `visited` guards against a parent cycle (A→B→A) recursing forever and, at
  // the end, lets us surface any tool a cycle would otherwise strand.
  const emit = (t: ToolActivity, depth: number) => {
    if (visited.has(t.callId)) return;
    visited.add(t.callId);
    out.push({ tool: t, depth });
    for (const child of childrenOf.get(t.callId) ?? []) emit(child, depth + 1);
  };
  // Roots (a tool that isn't a child of another in-group tool) anchor the walk,
  // in their original order; their descendants follow at increasing depth.
  for (const t of tools) if (!isChild(t)) emit(t, 0);
  // Any tool still unvisited belongs to a parent cycle with no root — emit it at
  // top level in place rather than hide it.
  for (const t of tools) if (!visited.has(t.callId)) emit(t, 0);
  return out;
}

/** Count every tool nested under `callId` in `tools` — direct children plus all
 *  deeper descendants — so a delegation's summary reflects its whole sub-tree.
 *  Cycle-safe (a `visited` set) and self-references are ignored. */
export function countDescendants(callId: string, tools: ToolActivity[]): number {
  const childrenOf = new Map<string, ToolActivity[]>();
  for (const t of tools) {
    const parent = t.parentToolUseId;
    if (!parent || parent === t.callId) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(t);
    childrenOf.set(parent, list);
  }
  const visited = new Set<string>([callId]);
  const stack = [...(childrenOf.get(callId) ?? [])];
  let count = 0;
  while (stack.length) {
    const t = stack.pop()!;
    if (visited.has(t.callId)) continue;
    visited.add(t.callId);
    count += 1;
    for (const child of childrenOf.get(t.callId) ?? []) stack.push(child);
  }
  return count;
}
