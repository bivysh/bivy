// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const surfaces = [
  "packages/web/src/components/AutomationsView.tsx",
  "packages/web/src/components/GithubQueue.tsx",
  "packages/web/src/components/QueueRouting.tsx",
  "packages/web/src/components/Settings.tsx",
  "packages/web/src/components/ConnectRunner.tsx",
  "packages/web/src/components/Ephemeral.tsx",
  "packages/web/src/components/NodeSwitcher.tsx",
  "packages/web/src/components/WorkQueueSetupSheet.tsx",
];

const source = surfaces.map((path) => readFileSync(path, "utf8")).join("\n");

/** These are exact customer-facing fragments, not internal route/type names.
 * Keeping the allowlist narrow lets compatibility identifiers such as `nodeId`
 * remain until APIs migrate without letting old product language return. */
test("primary PWA surfaces use the canonical product vocabulary", () => {
  const forbidden = [
    ">Work Queue<",
    'label: "Work Queue"',
    ">Outcome reports<",
    '"Copy sanitized report"',
    ">Ephemeral configs<",
    'label="Ephemeral configs"',
    ">Enrolled nodes<",
    'title: "Remove node?"',
    ">Nodes<",
    'label: "Nodes"',
    ">Runner<",
    "cloud runner",
    "Use this runner",
    "Waiting for a runner",
    ">Ephemeral machines<",
    "Needs node",
    "Node offline",
    "Finishing on the node",
    "on node</code>",
  ];
  for (const fragment of forbidden) {
    assert.equal(source.includes(fragment), false, `legacy customer copy returned: ${fragment}`);
  }

  for (const canonical of ['label: "Runs"', ">Run details<", 'label: "Machines"', "Isolated machine profiles"]) {
    assert.equal(source.includes(canonical), true, `canonical customer copy missing: ${canonical}`);
  }
});
