// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The PWA's tool-activity sheet nests a sub-agent's own steps beneath the
// delegation that spawned them (packages/web/src/components/tool-nesting.ts).
// This locks in the pure ordering: children follow their parent at depth 1 in
// original order, parents keep their order, and an orphan child (parent not in
// the group) stays top-level in place rather than disappearing.

import assert from "node:assert/strict";
import { orderToolsWithDepth } from "../packages/web/src/components/tool-nesting.js";

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

console.log("ok tool-nesting ordering");
