import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CertificationHarness, prepareAuthHandoff, type CertificationFixture } from "../src/certification/harness.js";
import { certificationEntry } from "../src/certification/index.js";
import { listRegisteredAgents } from "../src/runtime/index.js";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const matrix = JSON.parse(fs.readFileSync(path.join(root, "certification/agents.json"), "utf8"));
const fixtures = matrix.agents.map((agent: { id: string }) => JSON.parse(
  fs.readFileSync(path.join(root, "test/fixtures/certification", `${agent.id}.json`), "utf8"),
) as CertificationFixture);

// All adapters and scenarios run independently in normal CI. Promise.all is
// intentional: fixture state must not bleed across concurrently certified agents.
const runs = await Promise.all(fixtures.flatMap((fixture) => matrix.requiredScenarios.map(async (scenario: string) => {
  const result = await new CertificationHarness(fixture).run(scenario);
  assert.ok(result.events.length > 0);
  assert.ok(!result.transcript.includes(fixture.secretSentinel));
  return result;
})));
assert.equal(runs.length, fixtures.length * matrix.requiredScenarios.length);

// Auth handoff copies only the declared allowlist; audits are useful but cannot
// contain values. Unknown secrets never reach the child environment.
const auth = prepareAuthHandoff(
  { OPENAI_API_KEY: "top-secret", UNRELATED_SECRET: "must-not-cross" },
  ["OPENAI_API_KEY"],
);
assert.deepEqual(auth.environment, { OPENAI_API_KEY: "top-secret" });
assert.deepEqual(auth.redactedAudit, { OPENAI_API_KEY: "<redacted>" });
assert.ok(!JSON.stringify(auth.redactedAudit).includes("top-secret"));
assert.equal(auth.environment.UNRELATED_SECRET, undefined);

// Failure containment: leaked secrets, missing traces, malformed output without
// a protocol error, and cancellation are all hard failures.
const base = structuredClone(fixtures[0]);
base.scenarios["auth-handoff"] = [{ type: "debug", value: base.secretSentinel }];
await assert.rejects(() => new CertificationHarness(base).run("auth-handoff"), /Secret leakage/);
await assert.rejects(() => new CertificationHarness(fixtures[0]).run("not-certified"), /Missing certification scenario/);
const malformed = structuredClone(fixtures[0]);
malformed.scenarios["malformed-output"] = [{ raw: "{" }];
await assert.rejects(() => new CertificationHarness(malformed).run("malformed-output"), /did not satisfy its contract/);
const controller = new AbortController();
const cancelledRun = new CertificationHarness(fixtures[0]).run("first-turn", controller.signal);
controller.abort(new Error("cancelled by test"));
await assert.rejects(() => cancelledRun, /cancelled by test/);

// Supported means Bivy maintains the wrapper. Certification is narrower: the
// release-tested signal is attached only when the configured path matches the
// active matrix data; a different path remains Supported but adapter-tested.
process.env.BIVY_OPENCODE_ACP = "1";
const listed = listRegisteredAgents();
for (const entry of matrix.agents) {
  const runtime = listed.find((agent) => agent.id === entry.id)!;
  assert.equal(runtime.supportTier, "supported");
  assert.equal(runtime.executionMode, entry.executionMode);
  assert.equal(runtime.testedVersion, entry.upstream.pinnedVersion);
  assert.equal(runtime.certification, "release-tested");
  assert.equal(certificationEntry(runtime.id)?.status, "active");
}
process.env.BIVY_OPENCODE_ACP = "0";
const fallback = listRegisteredAgents().find((agent) => agent.id === "opencode")!;
assert.equal(fallback.executionMode, "pipe");
assert.equal(fallback.supportTier, "supported");
assert.equal(fallback.certification, "adapter-tested");
delete process.env.BIVY_OPENCODE_ACP;

console.log("agent-certification: all tests passed");
