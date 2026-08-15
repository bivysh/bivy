// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Generate docs/fork-matrix.md — the (source -> destination) fork-fidelity
// conformance matrix (phase 1E). Run: `pnpm run gen:fork-matrix`.
//
// The capability table below mirrors the fork flags each runtime actually
// declares (grep `forkTransport` / `forkHistoryImport` under src/agents and the
// ProtocolRuntime writeHistory hook). The tier logic itself is the shared,
// unit-tested src/session/fork-matrix.ts, which a test pins to the production
// resolveForkFidelity — so this file only supplies the inputs, never the rules.
// TODO(1E follow-up): introspect the live runtime registry instead of this table
// so a new agent's tiers appear automatically.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentForkCaps, renderForkMatrixMarkdown } from "../src/session/fork-matrix.js";

const FORK_CAPS: AgentForkCaps[] = [
  // Native same-runtime transport + portable-history import (full where same id).
  { id: "pi", displayName: "Pi", forkTransport: true, forkHistoryImport: true },
  { id: "claude", displayName: "Claude Code", forkTransport: true, forkHistoryImport: true },
  // Portable-history import only (replayed as a destination; no byte-exact self-fork).
  { id: "codex", displayName: "Codex", forkHistoryImport: true },
  { id: "opencode", displayName: "OpenCode", forkHistoryImport: true },
  // No fork import — always a seeded continuation as a destination.
  { id: "gemini", displayName: "Gemini" },
  { id: "aider", displayName: "Aider" },
  { id: "goose", displayName: "Goose" },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repoRoot, "docs", "fork-matrix.md");
const md = renderForkMatrixMarkdown(FORK_CAPS);
writeFileSync(out, md);
process.stdout.write(`Wrote ${path.relative(repoRoot, out)} (${FORK_CAPS.length} agents, ${FORK_CAPS.length ** 2} pairs).\n`);
