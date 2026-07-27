// Unit tests for the best-effort live-process detector backing native session
// discovery's "active" flag (src/runtime/native-process-scan.ts, issue #156).
// The OS process list is injected so these never depend on what's actually
// running on the machine running the suite.

import assert from "node:assert/strict";
import { hasLiveProcessForCwd, type OsProcessInfo } from "../src/runtime/native-process-scan.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const processes: OsProcessInfo[] = [
  { pid: 1, command: "claude", cwd: "/work/repo-a" },
  { pid: 2, command: "codex", cwd: "/work/repo-b" },
  { pid: 3, command: "bash", cwd: "/work/repo-a" },
  { pid: 4, command: "claude", cwd: undefined }, // cwd unknown (e.g. permission denied)
];
const lister = () => processes;

check("matches a live process by binary name + exact cwd", () => {
  assert.equal(hasLiveProcessForCwd("/work/repo-a", ["claude"], lister), true);
  assert.equal(hasLiveProcessForCwd("/work/repo-b", ["codex"], lister), true);
});

check("does not match a different cwd", () => {
  assert.equal(hasLiveProcessForCwd("/work/repo-c", ["claude"], lister), false);
});

check("does not match a different binary at the same cwd", () => {
  assert.equal(hasLiveProcessForCwd("/work/repo-a", ["codex"], lister), false);
});

check("is case-insensitive on the binary name", () => {
  assert.equal(hasLiveProcessForCwd("/work/repo-a", ["Claude"], lister), true);
});

check("normalizes relative/trailing-slash cwd spellings", () => {
  assert.equal(hasLiveProcessForCwd("/work/repo-a/", ["claude"], lister), true);
});

check("never reports live for an unknown cwd, even with a matching binary elsewhere", () => {
  // process 4 is a "claude" with no resolvable cwd — must never satisfy a match,
  // since that would be a guess, not a verified live process for THIS session.
  assert.equal(hasLiveProcessForCwd("", ["claude"], lister), false);
});

check("an empty cwd never matches", () => {
  assert.equal(hasLiveProcessForCwd("", ["claude"], lister), false);
});

check("a lister that throws is treated as no live process, not a crash", () => {
  const throwing = () => {
    throw new Error("ps not found");
  };
  assert.equal(hasLiveProcessForCwd("/work/repo-a", ["claude"], throwing), false);
});

if (failures > 0) {
  console.error(`\n${failures} native-process-scan test(s) failed.`);
  process.exit(1);
}
console.log("\nAll native-process-scan tests passed.");
