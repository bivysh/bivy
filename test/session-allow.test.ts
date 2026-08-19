import assert from "node:assert/strict";
import { approvalRememberKey, SessionAllowRules } from "../src/policy/session-allow.js";

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

check("shell keys are program + subcommand, never the full command", () => {
  assert.equal(approvalRememberKey("bash", { command: "git status --short" }), "git status");
  assert.equal(approvalRememberKey("Bash", { command: "npm test" }), "npm test");
  assert.equal(approvalRememberKey("bash", { command: "ls -la /tmp" }), "ls");
  assert.equal(approvalRememberKey("bash", { command: "./scripts/run.sh now" }), "./scripts/run.sh now");
  assert.equal(approvalRememberKey("bash", { command: "cat /etc/hosts" }), "cat");
  assert.equal(approvalRememberKey("bash", { command: "   " }), "bash");
  assert.equal(approvalRememberKey("bash", {}), "bash");
});

check("non-shell tools key on the tool name, case-folded", () => {
  assert.equal(approvalRememberKey("Edit", { file_path: "/ws/a.ts" }), "edit");
  assert.equal(approvalRememberKey("write", { path: "/ws/b.ts" }), "write");
});

check("rules are per session and cleared on close", () => {
  const rules = new SessionAllowRules();
  rules.allow("s1", "git status");
  assert.equal(rules.has("s1", "git status"), true);
  assert.equal(rules.has("s1", "git push"), false);
  assert.equal(rules.has("s2", "git status"), false);
  assert.deepEqual(rules.list("s1"), ["git status"]);
  rules.clear("s1");
  assert.equal(rules.has("s1", "git status"), false);
  assert.deepEqual(rules.list("s1"), []);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nsession-allow: all tests passed");
