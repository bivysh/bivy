import assert from "node:assert/strict";
import { PolicyEngine } from "../src/policy/policy-engine.js";

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

const noRisky = (_tool: string) => false;

// Persistent "remembered decisions" were removed — the engine now only applies
// the mode-based guard floor; anything beyond that is left to the agents.

check("behaves exactly like the base guard", () => {
  const policy = new PolicyEngine({ mode: "risky", isRiskyIntegration: noRisky });
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "curl http://x" }).decision, "ask");
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "ls" }).decision, "allow");
});

check("the hard floor denies catastrophic commands and workspace escapes in every mode", () => {
  const policy = new PolicyEngine({ mode: "autonomous", isRiskyIntegration: noRisky });
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "rm -rf /" }).decision, "deny");
  assert.equal(policy.decideToolCall("/ws", "write", { path: "../../etc/passwd" }).decision, "deny");
});

check("autonomous mode allows plain bash", () => {
  const policy = new PolicyEngine({ mode: "autonomous", isRiskyIntegration: noRisky });
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "npm test" }).decision, "allow");
});

check("unrestricted (danger-full-access) bypasses approvals and the workspace boundary", () => {
  const policy = new PolicyEngine({ mode: "always", unrestricted: true, isRiskyIntegration: () => true });
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "curl http://x" }).decision, "allow");
  assert.equal(policy.decideToolCall("/ws", "bash", { command: "sudo apt install foo" }).decision, "allow");
  assert.equal(policy.decideToolCall("/ws", "write", { path: "../../etc/passwd" }).decision, "allow");
  assert.equal(policy.decideToolCall("/ws", "some_risky_integration", {}).decision, "allow");
});

check("unrestricted (danger-full-access) still denies catastrophic commands", () => {
  const policy = new PolicyEngine({ mode: "never", unrestricted: true, isRiskyIntegration: () => false });
  for (const command of [
    "rm -rf /",
    "rm -rf ~",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "shutdown -h now",
  ]) {
    const result = policy.decideToolCall("/ws", "bash", { command });
    assert.equal(result.decision, "deny", `expected deny for: ${command}`);
    assert.match(result.reason ?? "", /catastrophic/);
  }
  // Runtime-specific casing (Claude Code sends `Bash`) must not slip past the floor.
  assert.equal(policy.decideToolCall("/ws", "Bash", { command: "rm -rf /usr" }).decision, "deny");
});

check("attaches a risk category to every decision", () => {
  const policy = new PolicyEngine({ mode: "autonomous", isRiskyIntegration: noRisky });
  assert.ok(typeof policy.decideToolCall("/ws", "bash", { command: "ls" }).risk === "string");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\npolicy-engine: all tests passed");
