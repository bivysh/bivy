// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { forkTier, forkMatrix, renderForkMatrixMarkdown, type AgentForkCaps } from "../src/session/fork-matrix.js";
import { resolveForkFidelity, type ForkBundle } from "../src/session/fork.js";
import type { AgentRuntime } from "../src/runtime/types.js";

test("tier logic matches the documented cases", () => {
  const pi: AgentForkCaps = { id: "pi", forkTransport: true, forkHistoryImport: true };
  const claude: AgentForkCaps = { id: "claude", forkTransport: true, forkHistoryImport: true };
  const codex: AgentForkCaps = { id: "codex", forkHistoryImport: true }; // no forkTransport
  const gemini: AgentForkCaps = { id: "gemini" }; // neither

  assert.equal(forkTier(pi, pi), "full", "same runtime with native transport");
  assert.equal(forkTier(claude, claude), "full");
  assert.equal(forkTier(codex, codex), "replayed", "same runtime but NO native transport → replayed, not full");
  assert.equal(forkTier(pi, claude), "replayed", "cross-runtime into a history importer");
  assert.equal(forkTier(pi, gemini), "seeded", "destination can't import history");
  assert.equal(forkTier(codex, gemini), "seeded");
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
    { id: "codex", displayName: "Codex", forkHistoryImport: true },
    { id: "gemini", displayName: "Gemini" },
  ];
  const cells = forkMatrix(agents);
  assert.equal(cells.length, 9);
  assert.equal(cells.find((c) => c.source === "pi" && c.dest === "pi")?.tier, "full");
  assert.equal(cells.find((c) => c.source === "codex" && c.dest === "gemini")?.tier, "seeded");

  const md = renderForkMatrixMarkdown(agents);
  assert.match(md, /Fork fidelity matrix/);
  assert.match(md, /Pi \| Codex \| Gemini/);
  assert.match(md, /●/); // at least one full cell (pi→pi)
});
