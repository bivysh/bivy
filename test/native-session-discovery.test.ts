// Unit tests for the capability-driven native session discovery/adoption
// policy (src/runtime/native-session-discovery.ts, issue #156). This module is
// pure — no filesystem/process access — so runtimes are faked entirely, per
// the issue's ask for "provider fixtures for path discovery, dedupe, resume,
// non-default homes, and unsupported runtimes" (the unsupported-runtime and
// dedupe cases live here; per-provider path discovery lives in
// codex-sessions.test.ts / claude-native-sessions.test.ts).

import assert from "node:assert/strict";
import {
  collectDiscoveredSessions,
  isAlreadyManaged,
  planNativeAdoption,
  type DiscoverableRuntime,
} from "../src/runtime/native-session-discovery.js";
import { sessionIdentityKey } from "../src/session-identity.js";
import type { DiscoveredNativeSession } from "../src/runtime/types.js";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((error) => {
      failures += 1;
      console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
    });
}

function session(overrides: Partial<DiscoveredNativeSession> = {}): DiscoveredNativeSession {
  return {
    runtimeId: "claude-code-sdk",
    ref: "session-a",
    cwd: "/work/repo",
    updatedAt: 1000,
    title: "add a test",
    active: false,
    resumable: true,
    ...overrides,
  };
}

function fakeRuntime(id: string, discovered: DiscoveredNativeSession[], opts: { supportsDiscovery?: boolean } = {}): DiscoverableRuntime {
  return {
    id,
    capabilities: { nativeSessionDiscovery: opts.supportsDiscovery !== false },
    discoverNativeSessions: async () => discovered,
  };
}

async function main() {
  await check("isAlreadyManaged matches by provider ref (id-based runtime)", () => {
    const keys = new Set([sessionIdentityKey({ id: "abc-123" })]);
    assert.equal(isAlreadyManaged({ ref: "abc-123" }, keys), true);
    assert.equal(isAlreadyManaged({ ref: "other" }, keys), false);
  });

  await check("isAlreadyManaged matches by on-disk transcript path even when the ref (id) differs", () => {
    // Mirrors Codex's exec vs approvals variants: different local ids, same rollout.
    const keys = new Set([sessionIdentityKey({ path: "/home/u/.codex/sessions/rollout-1.jsonl" })]);
    assert.equal(isAlreadyManaged({ ref: "thread-xyz", file: "/home/u/.codex/sessions/rollout-1.jsonl" }, keys), true);
    assert.equal(isAlreadyManaged({ ref: "thread-xyz", file: "/home/u/.codex/sessions/rollout-2.jsonl" }, keys), false);
  });

  await check("collectDiscoveredSessions drops sessions Bivy already manages", async () => {
    const managedRef = session({ ref: "managed-1" });
    const freshRef = session({ ref: "fresh-1", file: undefined });
    const runtime = fakeRuntime("claude-code-sdk", [managedRef, freshRef]);
    const result = await collectDiscoveredSessions([runtime], [{ id: "managed-1" }]);
    assert.deepEqual(result.map((s) => s.ref), ["fresh-1"]);
  });

  await check("collectDiscoveredSessions dedupes the same on-disk session surfaced by two runtime variants", async () => {
    const file = "/home/u/.codex/sessions/rollout-1.jsonl";
    const viaExec = session({ runtimeId: "codex", ref: "exec-local-id", file });
    const viaApprovals = session({ runtimeId: "codex-approvals", ref: "thread-xyz", file });
    const runtimes = [fakeRuntime("codex", [viaExec]), fakeRuntime("codex-approvals", [viaApprovals])];
    const result = await collectDiscoveredSessions(runtimes, []);
    assert.equal(result.length, 1, "only one of the two variants should surface");
  });

  await check("collectDiscoveredSessions ignores a runtime that doesn't advertise discovery (unsupported provider)", async () => {
    const unsupported = fakeRuntime("aider", [session({ runtimeId: "aider", ref: "whatever" })], { supportsDiscovery: false });
    const result = await collectDiscoveredSessions([unsupported], []);
    assert.deepEqual(result, []);
  });

  await check("collectDiscoveredSessions ignores a runtime with no discoverNativeSessions method even if it claims the capability", async () => {
    const broken: DiscoverableRuntime = { id: "weird", capabilities: { nativeSessionDiscovery: true } };
    const result = await collectDiscoveredSessions([broken], []);
    assert.deepEqual(result, []);
  });

  await check("collectDiscoveredSessions is best-effort: one runtime throwing doesn't blank the others", async () => {
    const broken: DiscoverableRuntime = {
      id: "flaky",
      capabilities: { nativeSessionDiscovery: true },
      discoverNativeSessions: async () => {
        throw new Error("store unreadable");
      },
    };
    const healthy = fakeRuntime("claude-code-sdk", [session({ ref: "ok-1" })]);
    const result = await collectDiscoveredSessions([broken, healthy], []);
    assert.deepEqual(result.map((s) => s.ref), ["ok-1"]);
  });

  await check("collectDiscoveredSessions sorts newest first", async () => {
    const runtime = fakeRuntime("claude-code-sdk", [
      session({ ref: "older", updatedAt: 100 }),
      session({ ref: "newer", updatedAt: 900 }),
    ]);
    const result = await collectDiscoveredSessions([runtime], []);
    assert.deepEqual(result.map((s) => s.ref), ["newer", "older"]);
  });

  await check("planNativeAdoption: idle + adoptable runtime -> native resume, no disclosure needed", () => {
    const plan = planNativeAdoption(session({ active: false, resumable: true }), { resume: true, nativeSessionAdoption: true });
    assert.equal(plan.mode, "native-resume");
    assert.equal(plan.disclosure, undefined);
  });

  await check("planNativeAdoption: live external process -> follow-only, with disclosure, regardless of capability", () => {
    const plan = planNativeAdoption(session({ active: true }), { resume: true, nativeSessionAdoption: true });
    assert.equal(plan.mode, "follow-only");
    assert.ok(plan.disclosure);
  });

  await check("planNativeAdoption: runtime can discover but not adopt -> seeded, with disclosure", () => {
    const plan = planNativeAdoption(session({ active: false }), { resume: true, nativeSessionAdoption: false });
    assert.equal(plan.mode, "seeded");
    assert.ok(plan.disclosure);
  });

  await check("planNativeAdoption: session itself isn't resumable -> seeded, even if the runtime supports adoption", () => {
    const plan = planNativeAdoption(session({ active: false, resumable: false }), { resume: true, nativeSessionAdoption: true });
    assert.equal(plan.mode, "seeded");
    assert.ok(plan.disclosure);
  });

  if (failures > 0) {
    console.error(`\n${failures} native-session-discovery test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll native-session-discovery tests passed.");
}

void main();
