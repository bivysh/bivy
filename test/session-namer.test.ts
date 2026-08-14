// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the session-naming state machine extracted from
// server.ts. The placeholder gate, the deterministic-then-smart rename, the
// attempt-cap retry window, and the first-prompt capture had no direct coverage
// while they lived inline; createSessionNamer's narrow deps make them testable.
import { strict as assert } from "node:assert";
import test from "node:test";

import { createSessionNamer, fallbackSessionName, cleanSessionName, type NamerDeps, type NamerSession } from "../src/session/session-namer.js";

function fakeSession(over: any = {}) {
  let name: string | undefined = over.name ?? "Session abcd1234";
  return {
    getName: () => name,
    setName: (n: string) => { name = n; },
    suggestName: over.suggestName ?? (async () => undefined),
    getCurrentModel: over.getCurrentModel ?? (() => undefined),
  };
}

function harness(over: Partial<NamerDeps> = {}) {
  const renamed: string[] = [];
  const broadcasts: any[] = [];
  const persisted: string[] = [];
  const deps: NamerDeps = {
    broadcast: (p) => broadcasts.push(p),
    persistSessionMetadata: (r) => persisted.push(r.id),
    scheduleAdvertise: () => {},
    renameBranch: (_r, n) => renamed.push(n),
    isPlaceholderName: (name) => !name || String(name).startsWith("Session ") || name === "Untitled",
    anthropicHeadersFromNodeCredential: async () => undefined,
    credsDir: "/c",
    piDir: "/p",
    ...over,
  };
  return { deps, renamed, broadcasts, persisted, namer: createSessionNamer(deps) };
}

test("fallbackSessionName takes the first ~6 words, stripping code/urls/markdown", () => {
  assert.equal(fallbackSessionName("**Fix** the `login` bug at https://x.io now please really"), "Fix the login bug at now");
  assert.equal(fallbackSessionName("```only code```"), undefined);
});

test("cleanSessionName strips quotes, control chars, trailing punctuation, caps length", () => {
  assert.equal(cleanSessionName('  "Add login flow."  '), "Add login flow");
});

test("an already-real name is treated as named and left untouched", async () => {
  const { namer, renamed, persisted } = harness();
  const record: NamerSession = { id: "s1", session: fakeSession({ name: "My Real Session" }) } as any;
  await namer.maybeNameSession(record, "some later message");
  assert.equal(record.session.getName(), "My Real Session", "name unchanged");
  assert.equal(record.namedFromFirstPrompt, true, "marked named so it won't re-derive");
  assert.deepEqual(renamed, [], "no branch rename");
  assert.deepEqual(persisted, [], "no persist");
});

test("placeholder + successful smart namer: deterministic first, then refined, then locked", async () => {
  const { namer, renamed, broadcasts } = harness();
  const record: NamerSession = { id: "abcd1234ef", session: fakeSession({ suggestName: async () => "Smart Title" }) } as any;
  await namer.maybeNameSession(record, "add user login flow");
  assert.equal(record.session.getName(), "Smart Title", "final name is the smart one");
  assert.deepEqual(renamed, ["add user login flow", "Smart Title"], "deterministic fallback branch rename, then refined");
  assert.equal(record.namedFromFirstPrompt, true, "locked once a model produced a name");
  assert.equal(record.naming, false, "naming flag reset in finally");
  assert.equal(broadcasts.filter((b) => b.type === "session.renamed").length, 2);
});

test("placeholder + all smart tiers fail: fallback stands, not locked, attempt counted", async () => {
  const { namer, renamed } = harness();
  const record: NamerSession = { id: "abcd1234ef", session: fakeSession() } as any;
  await namer.maybeNameSession(record, "fix the flaky test");
  assert.equal(record.session.getName(), "fix the flaky test", "deterministic fallback applied");
  assert.deepEqual(renamed, ["fix the flaky test"], "only the fallback branch rename");
  assert.equal(record.namingAttempts, 1, "attempt counted");
  assert.equal(record.namedFromFirstPrompt, undefined, "left unlocked so a later prompt can retry the smart tiers");
  assert.equal(record.firstNamingPrompt, "fix the flaky test", "first prompt captured for stable retries");
});

test("re-entrancy: a naming already in flight is a no-op", async () => {
  const { namer, renamed } = harness();
  const record: NamerSession = { id: "abcd1234ef", naming: true, session: fakeSession() } as any;
  await namer.maybeNameSession(record, "hello there");
  assert.equal(record.session.getName(), "Session abcd1234", "untouched");
  assert.deepEqual(renamed, []);
});

test("setSessionName sets, locks, persists, and survives a later interactive message", async () => {
  const { namer, persisted, broadcasts } = harness();
  const record: NamerSession = { id: "s9", session: fakeSession() } as any;
  namer.setSessionName(record, "  Manual Title  ");
  assert.equal(record.session.getName(), "Manual Title", "trimmed and set");
  assert.equal(record.namedFromFirstPrompt, true, "locked against the first-prompt namer");

  // Run-created sessions are named explicitly before their internal turn. A
  // later human follow-up must not replace that Run title with e.g. "status".
  await namer.maybeNameSession(record, "status");
  assert.equal(record.session.getName(), "Manual Title");
  assert.deepEqual(persisted, ["s9"]);
  assert.equal(broadcasts.filter((b) => b.type === "session.renamed").length, 1);
});
