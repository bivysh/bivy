// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Unit tests for the app-owned ruleset registry (src/runtime/ruleset-store.ts):
// validate-on-save, active selection, context-gated activeRulesetFor, and
// tolerant load of a hand-mangled file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listRulesetInfos,
  upsertRuleset,
  removeRuleset,
  activeRulesetFor,
  loadRulesets,
} from "../src/runtime/ruleset-store.js";
import type { Ruleset } from "../src/policy/ruleset.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-rulesets-"));
}

const sample = (name: string, appliesTo: Array<"session" | "queue"> = ["queue"]): Ruleset => ({
  version: 1,
  name,
  appliesTo,
  rules: [{ when: ["transport_error"], action: "retry", maxAttempts: 3 }],
});

check("upsert stores a valid ruleset and list reflects it", () => {
  const dir = tmpDir();
  upsertRuleset(dir, sample("alpha"));
  const infos = listRulesetInfos(dir);
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.name, "alpha");
  assert.equal(infos[0]!.active, false);
});

check("upsert rejects an invalid ruleset with a readable error", () => {
  const dir = tmpDir();
  assert.throws(
    () => upsertRuleset(dir, { version: 1, name: "", appliesTo: [], rules: "nope" }),
    /Invalid ruleset:/,
  );
  assert.equal(listRulesetInfos(dir).length, 0);
});

check("active flag is exclusive and surfaced in the list", () => {
  const dir = tmpDir();
  upsertRuleset(dir, sample("alpha"), true);
  upsertRuleset(dir, sample("beta"), true); // beta becomes active, alpha demoted
  const byName = Object.fromEntries(listRulesetInfos(dir).map((r) => [r.name, r.active]));
  assert.equal(byName.alpha, false);
  assert.equal(byName.beta, true);
  // Re-saving beta with active:false clears the active selection.
  upsertRuleset(dir, sample("beta"), false);
  assert.equal(loadRulesets(dir).activeName, null);
});

check("activeRulesetFor only returns a ruleset that applies to the context", () => {
  const dir = tmpDir();
  upsertRuleset(dir, sample("session-only", ["session"]), true);
  assert.equal(activeRulesetFor(dir, "queue"), undefined); // active, but not for the queue
  assert.ok(activeRulesetFor(dir, "session"));
});

check("activeRulesetFor is undefined when nothing is active", () => {
  const dir = tmpDir();
  upsertRuleset(dir, sample("alpha"));
  assert.equal(activeRulesetFor(dir, "queue"), undefined);
});

check("removing the active ruleset clears the active selection", () => {
  const dir = tmpDir();
  upsertRuleset(dir, sample("alpha"), true);
  removeRuleset(dir, "alpha");
  assert.equal(listRulesetInfos(dir).length, 0);
  assert.equal(loadRulesets(dir).activeName, null);
});

check("load tolerates a corrupt file and drops invalid entries", () => {
  const dir = tmpDir();
  // A garbage file must not throw — the store returns an empty registry.
  fs.writeFileSync(path.join(dir, "rulesets.json"), "{ not json");
  assert.deepEqual(loadRulesets(dir), { activeName: null, rulesets: {} });
  // A file with one valid and one invalid entry keeps only the valid one, and
  // an activeName pointing at a dropped entry is nulled.
  fs.writeFileSync(
    path.join(dir, "rulesets.json"),
    JSON.stringify({ activeName: "bogus", rulesets: { good: sample("good"), bad: { name: "bad" } } }),
  );
  const infos = listRulesetInfos(dir);
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.name, "good");
  assert.equal(loadRulesets(dir).activeName, null);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nruleset-store: all tests passed");
