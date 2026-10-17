// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, seal } from "../src/e2e.js";
import { handOffToRunner, type HandOffDeps } from "../src/runner-handoff.js";

const own = randomBytes(32);
const runnerKey = randomBytes(32);
const item = { id: "w1", body: `bivy-room-v1:eph-managed-auto-a:${seal(own, "fix the flaky test")}` };

function deps(overrides: Partial<HandOffDeps> & { offlineFor?: number } = {}) {
  const posts: Array<{ path: string; body: any }> = [];
  let offline = overrides.offlineFor ?? 0;
  const d: HandOffDeps = {
    nodeId: "eph-managed-auto-a",
    post: async (path, body) => { posts.push({ path, body }); return path === "/node/runners" ? { nodeId: "eph-runner-1" } : { ok: true }; },
    roomKeyOf: async () => { if (offline-- > 0) throw new Error("offline"); return runnerKey; },
    openSealed: (payload) => open(own, payload),
    seal,
    sleep: async () => {},
    retryMs: 1,
    log: () => {},
    ...overrides,
  };
  return { d, posts };
}

// The instructions reach the runner re-sealed under its key, never in the clear.
{
  const { d, posts } = deps({ offlineFor: 2 });
  assert.equal(await handOffToRunner(d, item), true);
  const handoff = posts.find((p) => p.path === "/node/work/w1/handoff")!;
  assert.equal(handoff.body.nodeId, "eph-runner-1");
  const [, node, ...payload] = handoff.body.body.split(":");
  assert.equal(node, "eph-runner-1");
  assert.equal(open(runnerKey, payload.join(":")), "fix the flaky test", "the runner can open it, after waiting for it to come online");
  assert.ok(!JSON.stringify(posts).includes("fix the flaky test"), "the control plane never sees the instructions");
}

// No runner, one that never comes online, or a refused move: the item runs here.
{
  assert.equal(await handOffToRunner(deps({ post: async () => { throw new Error("no free runner"); } }).d, item), false);
  assert.equal(await handOffToRunner(deps({ offlineFor: Infinity, waitMs: 0 }).d, item), false);
  const refused = deps({ post: async (path) => { if (path.endsWith("/handoff")) throw new Error("moved"); return { nodeId: "eph-runner-1" }; } });
  assert.equal(await handOffToRunner(refused.d, item), false);
}

// Work sealed to another machine, or a continuation of a session here, stays.
{
  const { d, posts } = deps();
  assert.equal(await handOffToRunner(d, { id: "w2", body: "bivy-room-v1:other:x" }), false);
  assert.equal(await handOffToRunner(d, { ...item, targetKind: "existing_session" }), false);
  assert.equal(posts.length, 0);
}

console.log("runner-handoff: all tests passed");
