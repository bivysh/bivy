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
const publicDocs = [
  "README.md",
  "docs/why-bivy.md",
  "docs/slack-setup.md",
  "docs/automation-runs.md",
  "docs/cli-reference.md",
];
const publicCopy = publicDocs.map((path) => readFileSync(path, "utf8")).join("\n");

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
    "Isolated machine profiles",
    "Unattended machines",
    "Needs node",
    "Node offline",
    "Finishing on the node",
    "on node</code>",
  ];
  for (const fragment of forbidden) {
    assert.equal(source.includes(fragment), false, `legacy customer copy returned: ${fragment}`);
  }

  for (const canonical of ['label: "Runs"', ">Run details<", 'label: "Machines"', "Cloud machine profiles", "Run automations while I'm offline"]) {
    assert.equal(source.includes(canonical), true, `canonical customer copy missing: ${canonical}`);
  }
});

test("primary public copy follows the product and trust contracts", () => {
  const forbidden = [
    "## GitHub work queue",
    "## Linear work queue",
    "## Nodes and remote access",
    "Settings → Work Queue",
    '"Outcome reports"',
    "without your code or secrets ever leaving hardware you own",
    "the parts we help host are *blind*",
    "anything hosted is blind",
    "provable record of everything it did",
  ];
  for (const fragment of forbidden) {
    assert.equal(publicCopy.includes(fragment), false, `obsolete or overstated public claim returned: ${fragment}`);
  }

  for (const required of [
    "Run agents where your environment lives",
    "Claude Code and Codex are the recommended",
    "credential custodian",
    "not a signed attestation",
  ]) {
    assert.equal(publicCopy.includes(required), true, `required public product truth missing: ${required}`);
  }
});
