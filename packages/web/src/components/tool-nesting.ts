// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ToolActivity } from "@bivy/core";

/** Order a group's tools so a sub-agent's steps sit directly beneath the
 *  delegation that spawned them (depth 1), instead of flat and unlabelled among
 *  the parent's own calls. A child is any tool carrying a `parentToolUseId` that
 *  matches another tool's `callId` in the same group; children keep their
 *  original relative order under their parent. Tools whose parent isn't in the
 *  group stay top-level in place, so the ordering never hides work. Pure and
 *  React-free so it can be unit-tested directly. */
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
  for (const t of tools) {
    if (isChild(t)) continue;
    out.push({ tool: t, depth: 0 });
    for (const child of childrenOf.get(t.callId) ?? []) out.push({ tool: child, depth: 1 });
  }
  return out;
}
