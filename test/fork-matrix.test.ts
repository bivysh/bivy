// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { forkTier, forkMatrix, renderForkMatrixMarkdown, type AgentForkCaps } from "../src/session/fork-matrix.js";
import { resolveForkFidelity, type ForkBundle } from "../src/session/fork.js";
import { forkMatrixAgents, listRegisteredAgents } from "../src/runtime/index.js";
import { AGENT_PROFILE_IDS } from "../src/agents/profiles.js";
import type { AgentRuntime } from "../src/runtime/types.js";

test("tier logic matches the documented cases", () => {
  const pi: AgentForkCaps = { id: "pi", forkTransport: true, forkHistoryImport: true };
  const claude: AgentForkCaps = { id: "claude", forkTransport: true, forkHistoryImport: true };
  // History-import only (no native transport) — a synthetic capability combo, not
  // a specific agent. Real Codex/OpenCode DO expose forkTransport, so this uses a
  // neutral id to avoid asserting a false fact about any shipping runtime.
  const importerOnly: AgentForkCaps = { id: "importer-only", forkHistoryImport: true };
  const gemini: AgentForkCaps = { id: "gemini" }; // neither

  assert.equal(forkTier(pi, pi), "full", "same runtime with native transport");
  assert.equal(forkTier(claude, claude), "full");
  assert.equal(forkTier(importerOnly, importerOnly), "replayed", "same runtime but NO native transport → replayed, not full");
  assert.equal(forkTier(pi, claude), "replayed", "cross-runtime into a history importer");
  assert.equal(forkTier(pi, gemini), "seeded", "destination can't import history");
  assert.equal(forkTier(importerOnly, gemini), "seeded");
});

// Build a fake runtime + bundle exactly as resolveForkFidelity inspects them, so
// we can prove the pure matrix agrees with the production decision path.
function fakeRuntime(caps: AgentForkCaps): AgentRuntime {
  return {
    id: caps.id,
    capabilities: { forkTransport: !!caps.forkTransport, forkHistoryImport: !!caps.forkHistoryImport },
    ...(caps.forkTransport ? { importForFork: async () => ({ sessionFile: "/s", id: "x" }) } : {}),
    ...(caps.forkHistoryImport ? { importHistoryForFork: async () => ({ sessionFile: "/s", id: "x" }) } : {}),
  } as unknown as AgentRuntime;
}
function fakeBundle(source: AgentForkCaps): ForkBundle {
  return {
    record: { sourceSessionId: "s", runtimeId: source.id, workspace: "/w", cwd: "/w" },
    normalized: { turns: [{ role: "user", text: "hi" }] } as any,
    // A native payload is only captured when the source speaks native transport.
    ...(source.forkTransport ? { native: { runtimeId: source.id, data: {} } as any } : {}),
  };
}

test("matrix agrees with the real resolveForkFidelity for every capability combo", () => {
  const combos: AgentForkCaps[] = [
    { id: "A" },
    { id: "A", forkHistoryImport: true },
    { id: "A", forkTransport: true },
    { id: "A", forkTransport: true, forkHistoryImport: true },
  ];
  // Same-id (all use id "A" here) exercises the full-vs-replayed boundary; a
  // distinct id exercises the cross-runtime branch.
  for (const s of combos) {
    for (const d of combos) {
      const bundle = fakeBundle(s);
      const dest = fakeRuntime(d);
      const production = resolveForkFidelity(bundle, dest);
      const pure = forkTier({ ...s, id: "A" }, { ...d, id: "A" });
      assert.equal(pure, production, `combo source=${JSON.stringify(s)} dest=${JSON.stringify(d)}`);

      // Cross-runtime (different ids): full is impossible, so only replayed/seeded.
      const crossBundle = { ...bundle, record: { ...bundle.record, runtimeId: "S" } };
      if (bundle.native) (crossBundle as any).native = { runtimeId: "S", data: {} };
      const crossProd = resolveForkFidelity(crossBundle, fakeRuntime({ ...d, id: "D" }));
      const crossPure = forkTier({ ...s, id: "S" }, { ...d, id: "D" });
      assert.equal(crossPure, crossProd, `cross combo source=${JSON.stringify(s)} dest=${JSON.stringify(d)}`);
    }
  }
});

test("matrix + markdown render", () => {
  const agents: AgentForkCaps[] = [
    { id: "pi", displayName: "Pi", forkTransport: true, forkHistoryImport: true },
    { id: "codex", displayName: "Codex", forkTransport: true, forkHistoryImport: true },
    { id: "gemini", displayName: "Gemini" },
  ];
  const cells = forkMatrix(agents);
  assert.equal(cells.length, 9);
  assert.equal(cells.find((c) => c.source === "pi" && c.dest === "pi")?.tier, "full");
  assert.equal(cells.find((c) => c.source === "codex" && c.dest === "codex")?.tier, "full", "Codex exposes native forkTransport → self-fork is byte-exact");
  assert.equal(cells.find((c) => c.source === "codex" && c.dest === "gemini")?.tier, "seeded");

  const md = renderForkMatrixMarkdown(agents);
  assert.match(md, /Fork fidelity matrix/);
  assert.match(md, /Pi \| Codex \| Gemini/);
  assert.match(md, /●/); // at least one full cell (pi→pi)
});

// --- Registry drift guards: the generated matrix is derived from the LIVE agent
// registry, so these pin the two ways it could silently drift: (1) a maintained
// full-fidelity agent's catalog describe() forgetting the fork capabilities its
// runtime actually delivers, and (2) a newly added agent never reaching the doc.

test("maintained full-fidelity agents declare their real fork capabilities in the catalog", () => {
  const infos = listRegisteredAgents();
  for (const id of ["pi", "claude-code-sdk", "codex-approvals", "opencode"]) {
    const info = infos.find((entry) => entry.id === id);
    assert.ok(info, `registry is missing ${id}`);
    assert.equal(info!.capabilities.forkTransport, true, `${id} must advertise forkTransport (byte-exact same-runtime fork)`);
    assert.equal(info!.capabilities.forkHistoryImport, true, `${id} must advertise forkHistoryImport (cross-runtime replay INTO it)`);
  }
});

test("fork matrix covers every built-in coding agent and lands the right tiers", () => {
  const caps = forkMatrixAgents();
  const ids = new Set(caps.map((c) => c.id));

  // Every profile-driven agent (minus the hidden plain-codex exec duplicate) plus
  // the maintained integrations must appear — no silent omission as agents are added.
  for (const id of AGENT_PROFILE_IDS) {
    if (id === "codex") continue; // superseded by the governed codex-approvals row
    assert.ok(ids.has(id), `fork matrix is missing profile agent "${id}"`);
  }
  for (const id of ["pi", "claude-code-sdk", "codex-approvals"]) {
    assert.ok(ids.has(id), `fork matrix is missing maintained agent "${id}"`);
  }
  // Meta/host and duplicate rows must NOT leak into the coding-agent matrix.
  for (const id of ["generic-cli", "bivy-agent-protocol", "acp", "codex"]) {
    assert.ok(!ids.has(id), `fork matrix should not include meta/duplicate row "${id}"`);
  }

  const cells = forkMatrix(caps);
  const tier = (source: string, dest: string) => cells.find((c) => c.source === source && c.dest === dest)?.tier;
  // OpenCode is a full same-runtime fork and a replayed cross-runtime destination.
  assert.equal(tier("opencode", "opencode"), "full");
  assert.equal(tier("grok", "opencode"), "replayed", "a fork FROM grok INTO opencode replays the transcript");
  assert.equal(tier("pi", "opencode"), "replayed");
  // A store-less agent is only ever a seeded destination.
  assert.equal(tier("pi", "grok"), "seeded");
  assert.equal(tier("grok", "grok"), "seeded", "grok has no fork transport → even a self-fork is seeded");
});
