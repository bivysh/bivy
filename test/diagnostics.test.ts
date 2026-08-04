import assert from "node:assert/strict";
import { buildDiagnosticsReport, activationRecord, ACTIVATION_STAGES } from "../src/diagnostics.js";

// B4d — a shareable diagnostics bundle carries no secrets or content, only
// versions, health counters, whitelisted config, and the activation record.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

check("only whitelisted config keys are included; secrets are dropped", () => {
  const report = buildDiagnosticsReport({
    env: {
      BIVY_APPROVAL_MODE: "autonomous",
      BIVY_SANDBOX: "workspace-write",
      ANTHROPIC_API_KEY: "sk-ant-supersecret",
      BIVY_GITHUB_TOKEN: "ghp_secrettoken",
      SOME_RANDOM: "value",
    },
  });
  assert.equal(report.config.BIVY_APPROVAL_MODE, "autonomous");
  assert.equal(report.config.BIVY_SANDBOX, "workspace-write");
  assert.equal("ANTHROPIC_API_KEY" in report.config, false, "a secret env var must be dropped entirely");
  assert.equal("BIVY_GITHUB_TOKEN" in report.config, false);
  assert.equal("SOME_RANDOM" in report.config, false, "non-whitelisted keys are dropped");
});

check("string leaves in health are redacted defensively", () => {
  const report = buildDiagnosticsReport({
    health: { publicUrl: "https://user:ghp_abc123def456ghi789jkl012mno345pqr@host/x", sessions: 3 },
  });
  assert.ok(!JSON.stringify(report.health).includes("ghp_abc123def456ghi789jkl012mno345pqr"), "an embedded token must be masked");
  assert.equal(report.health.sessions, 3, "non-string counters pass through");
});

check("activationRecord reports the golden-path stages and where it's blocked", () => {
  const rec = activationRecord({ nodeOnline: true, runtimeReady: true, credentialReady: false, repoChosen: false, firstTaskReady: false });
  assert.deepEqual(rec.map((r) => r.stage), [...ACTIVATION_STAGES]);
  assert.equal(rec.find((r) => r.stage === "node_online")!.status, "ok");
  assert.equal(rec.find((r) => r.stage === "credential")!.status, "blocked");
  assert.equal(rec.find((r) => r.stage === "first_task")!.status, "blocked");
});

check("an agent-managed credential is skipped, not blocked", () => {
  const rec = activationRecord({ nodeOnline: true, runtimeReady: true, credentialReady: null, repoChosen: true, firstTaskReady: true });
  assert.equal(rec.find((r) => r.stage === "credential")!.status, "skipped");
  assert.equal(rec.find((r) => r.stage === "first_task")!.status, "ok");
});

if (failures > 0) { console.error(`\n${failures} diagnostics test(s) failed`); process.exit(1); }
console.log("\ndiagnostics: all tests passed");
