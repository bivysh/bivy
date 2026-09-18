// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Generate docs/fork-matrix.md — the (source -> destination) fork-fidelity
// conformance matrix. Run: `pnpm run gen:fork-matrix`.
//
// The agent list AND the per-agent fork capabilities are now derived from the
// LIVE agent registry (listRegisteredAgents), not a hand-maintained table — so
// a newly added agent's tiers appear automatically and can never silently drift
// from the code (the old TODO). The tier logic itself is the shared,
// unit-tested src/session/fork-matrix.ts, which a test pins to the production
// resolveForkFidelity — so this file only supplies the inputs, never the rules.
//
// A test (test/fork-matrix.test.ts) asserts that every built-in coding agent in
// the registry appears in this matrix, and that the maintained full-fidelity
// agents (Pi/Claude/Codex/OpenCode) declare the fork capabilities they actually
// deliver — so this generated doc can't drift from the shipping catalog.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentForkCaps, renderForkMatrixMarkdown } from "../src/session/fork-matrix.js";
import { forkMatrixAgents } from "../src/runtime/index.js";

const caps: AgentForkCaps[] = forkMatrixAgents();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repoRoot, "docs", "fork-matrix.md");
const md = renderForkMatrixMarkdown(caps);
writeFileSync(out, md);
process.stdout.write(`Wrote ${path.relative(repoRoot, out)} (${caps.length} agents, ${caps.length ** 2} pairs).\n`);
