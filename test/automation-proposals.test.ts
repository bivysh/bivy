// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// An agent's `bivy automation apply` is a proposal: nothing reaches the
// account until the user approves the changes shown to them.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutomationProposals, type AutomationChange, type CliRun } from "../src/session/automation-proposals.js";

const changes: AutomationChange[] = [{ id: "nightly-tests", action: "create", name: "Nightly tests", enabled: true, trigger: "schedule", schedule: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" }, agent: "node default", sandbox: "workspace-write", approval: "risky" }];

function setup(decision: "approved" | "rejected" | "expired", dryRun: CliRun = { code: 0, stdout: JSON.stringify({ changes }), stderr: "" }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-proposal-"));
  fs.mkdirSync(path.join(workspace, ".bivy"));
  fs.writeFileSync(path.join(workspace, ".bivy", "automations.yaml"), "version: 1\n");
  const runs: string[][] = [];
  const asked: Array<{ file: string; changes: AutomationChange[] }> = [];
  let decide!: () => void;
  const proposals = new AutomationProposals({
    runCli: async (args) => { runs.push(args); return args.includes("--dry-run") ? dryRun : { code: 0, stdout: "+ nightly-tests\nApplied: 1 created, 0 updated, 0 removed.", stderr: "" }; },
    requestApproval: (input) => { asked.push(input); return new Promise((resolve) => { decide = () => resolve(decision); }); },
  });
  const settle = async () => { decide(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
  return { workspace, proposals, runs, asked, settle };
}

test("approved: the user sees the dry run's changes, then the file is applied", async () => {
  const { workspace, proposals, runs, asked, settle } = setup("approved");
  const proposal = await proposals.propose("s", workspace, ".bivy/automations.yaml", false);
  assert.ok(!("error" in proposal));
  assert.equal(proposal.status, "pending");
  assert.deepEqual(asked[0]?.changes, changes);
  assert.equal(runs.length, 1, "only the dry run before the user answers");
  await settle();
  const done = proposals.get("s", proposal.id);
  assert.equal(done?.status, "applied");
  assert.match(done?.output ?? "", /Applied: 1 created/);
  assert.ok(!runs[1]!.includes("--dry-run"));
  assert.equal(proposals.get("other-session", proposal.id), undefined);
});

test("declined: nothing is applied", async () => {
  const { workspace, proposals, runs, settle } = setup("rejected");
  const proposal = await proposals.propose("s", workspace, ".bivy/automations.yaml", false);
  assert.ok(!("error" in proposal));
  await settle();
  assert.equal(proposals.get("s", proposal.id)?.status, "rejected");
  assert.equal(runs.length, 1);
});

test("a file outside the workspace, or one that doesn't check, never reaches the user", async () => {
  const outside = setup("approved");
  assert.match(String((await outside.proposals.propose("s", outside.workspace, "/etc/hosts", false) as { error: string }).error), /inside the session workspace/);
  const broken = setup("approved", { code: 1, stdout: "", stderr: "Automation error: automations[0].schedule is required" });
  assert.match(String((await broken.proposals.propose("s", broken.workspace, ".bivy/automations.yaml", false) as { error: string }).error), /schedule is required/);
  assert.equal(outside.asked.length + broken.asked.length, 0);
});
