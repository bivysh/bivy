// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import type { RuntimeInfo } from "@bivy/core";
import {
  filterAndSortAgentRuntimes,
  isTopAgent,
} from "../packages/web/src/agentPickerCatalog.js";

const runtime = (id: string, displayName: string, description = "") => ({
  id,
  displayName,
  description,
}) as RuntimeInfo;

const runtimes = [
  runtime("pi", "Pi"),
  runtime("aider", "Aider", "Mentions Claude in its description"),
  runtime("opencode", "OpenCode"),
  runtime("grok", "Grok"),
  runtime("codex-approvals", "Codex"),
  runtime("claude-code-sdk", "Claude Code"),
  runtime("cursor", "Cursor"),
];

assert.deepEqual(
  runtimes.filter(isTopAgent).map((agent) => agent.id),
  ["pi", "opencode", "grok", "codex-approvals", "claude-code-sdk"],
  "the requested five agents form the top section",
);

assert.deepEqual(
  filterAndSortAgentRuntimes(runtimes.filter(isTopAgent), "").map((agent) => agent.displayName),
  ["Claude Code", "Codex", "Grok", "OpenCode", "Pi"],
  "top agents are alphabetical by display name",
);

assert.deepEqual(
  filterAndSortAgentRuntimes(runtimes.filter((agent) => !isTopAgent(agent)), "").map((agent) => agent.displayName),
  ["Aider", "Cursor"],
  "remaining agents are alphabetical by display name",
);

assert.deepEqual(
  filterAndSortAgentRuntimes(runtimes, "claude").map((agent) => agent.id),
  ["claude-code-sdk"],
  "search matches only the displayed agent name, not descriptions",
);
assert.deepEqual(
  filterAndSortAgentRuntimes(runtimes, "codex-approvals"),
  [],
  "search does not match internal runtime IDs",
);

console.log("agent picker catalog tests passed");
