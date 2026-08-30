import assert from "node:assert/strict";
import { firstSessionDecisions, firstSessionSummary } from "../packages/web/src/firstSession.js";

// B2 — a first session exposes exactly four decisions: machine, repo,
// agent/model, protection. Always four, in golden-path order.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

check("always exactly four decisions, in golden-path order", () => {
  const d = firstSessionDecisions({ machine: "laptop", repo: "bivy", agent: "Pi", model: "Opus", protection: "Workspace write" });
  assert.deepEqual(d.map((x) => x.key), ["machine", "repo", "agent-model", "protection"]);
  assert.equal(d.length, 4);
  assert.equal(d[2]!.value, "Pi · Opus");
});

check("folds model into agent when the agent manages its own model", () => {
  const d = firstSessionDecisions({ agent: "Codex", model: "gpt", modelManagedByAgent: true });
  assert.equal(d[2]!.value, "Codex", "no model half when the agent owns model selection");
});

check("missing values render as actionable defaults, never a fifth or dropped decision", () => {
  const d = firstSessionDecisions({});
  assert.equal(d.length, 4);
  assert.deepEqual(d.map((x) => x.value), [
    "Machine default",
    "No repository",
    "Choose an agent · Choose a model",
    "Machine default",
  ]);
});

check("summary is a single one-line join of the four", () => {
  assert.equal(
    firstSessionSummary({ machine: "laptop", repo: "bivy", agent: "Pi", model: "Opus", protection: "Read-only" }),
    "laptop  ·  bivy  ·  Pi · Opus  ·  Read-only",
  );
});

if (failures > 0) { console.error(`\n${failures} first-session test(s) failed`); process.exit(1); }
console.log("\nfirst-session: all tests passed");
