// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The PWA's tool-activity sheet nests a sub-agent's own steps beneath the
// delegation that spawned them (packages/web/src/components/tool-nesting.ts).
// This locks in the pure ordering: children follow their parent at depth 1 in
// original order, parents keep their order, and an orphan child (parent not in
// the group) stays top-level in place rather than disappearing.

import assert from "node:assert/strict";
import { orderToolsWithDepth, countDescendants } from "../packages/web/src/components/tool-nesting.js";

const tool = (callId: string, parentToolUseId?: string) =>
  ({ callId, name: "bash", input: {}, status: "done" as const, ...(parentToolUseId ? { parentToolUseId } : {}) });

// Parent, an unrelated call, then two children of the parent interleaved.
{
  const ordered = orderToolsWithDepth([
    tool("task-1"),
    tool("bash-1", "task-1"),
    tool("read-1"),
    tool("bash-2", "task-1"),
  ]);
  assert.deepEqual(
    ordered.map((o) => [o.tool.callId, o.depth]),
    [["task-1", 0], ["bash-1", 1], ["bash-2", 1], ["read-1", 0]],
    "children group under their parent at depth 1, parents keep order",
  );
}

// An orphan child (parent not present) stays a top-level row in place.
{
  const ordered = orderToolsWithDepth([tool("read-1"), tool("bash-1", "missing")]);
  assert.deepEqual(ordered.map((o) => [o.tool.callId, o.depth]), [["read-1", 0], ["bash-1", 0]]);
}

// A self-referential parent id never recurses or hides the row.
{
  const ordered = orderToolsWithDepth([tool("loop", "loop")]);
  assert.deepEqual(ordered.map((o) => [o.tool.callId, o.depth]), [["loop", 0]]);
}

// Arbitrary depth: a sub-agent that itself delegates (grandchild) nests one
// level deeper instead of being dropped. A depth-1-only walk hid grandchildren
// entirely; they must appear beneath their parent at depth 2.
{
  const ordered = orderToolsWithDepth([
    tool("task-1"),
    tool("sub-task", "task-1"),
    tool("grand-bash", "sub-task"),
    tool("parent-bash", "task-1"),
  ]);
  assert.deepEqual(
    ordered.map((o) => [o.tool.callId, o.depth]),
    [["task-1", 0], ["sub-task", 1], ["grand-bash", 2], ["parent-bash", 1]],
    "grandchildren nest at depth 2 under their (child) parent, preserving order",
  );
}

// A parent cycle with no root (A→B, B→A) still surfaces both rows rather than
// hiding the work: the first is anchored at top level and the second nests under
// it once (the walk breaks the cycle instead of looping forever or dropping a row).
{
  const ordered = orderToolsWithDepth([tool("a", "b"), tool("b", "a")]);
  assert.deepEqual(ordered.map((o) => [o.tool.callId, o.depth]), [["a", 0], ["b", 1]]);
  assert.equal(ordered.length, 2, "no row is hidden and none is duplicated");
}

// countDescendants sums the whole sub-tree (children + grandchildren), not just
// direct children, and is cycle-safe.
{
  const tools = [tool("task-1"), tool("sub-task", "task-1"), tool("grand-bash", "sub-task"), tool("parent-bash", "task-1")];
  assert.equal(countDescendants("task-1", tools), 3, "task-1 owns 3 nested steps in total");
  assert.equal(countDescendants("sub-task", tools), 1, "sub-task owns just its own grandchild");
  assert.equal(countDescendants("grand-bash", tools), 0, "a leaf owns nothing");
  assert.equal(countDescendants("a", [tool("a", "b"), tool("b", "a")]), 1, "cycle counts the other node once, no infinite loop");
}

console.log("ok tool-nesting ordering");
