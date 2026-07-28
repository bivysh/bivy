// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyGithubSignature,
  parseGithubIssueEvent,
  pickRoutingLabel,
  pickIssueRoutingLabel,
  verifySlackSignature,
  parseSlackCommand,
  extractMentions,
  parseGithubCommentEvent,
  pickCommentRoutingLabel,
  parseInstallationId,
  applyDefaultNode,
  verifyAutomationSignature,
  parseAutomationEvent,
  renderAutomationInstruction,
} from "../src/webhooks.js";

/**
 * Inbound front-door helpers (E2 GitHub webhook, E4 Slack). Pure functions, so
 * they unit-test without a server.
 */

let passed = 0;
async function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("github signature: accepts a correct sha256 hmac, rejects tampering", () => {
  const secret = "shhh";
  const body = JSON.stringify({ hello: "world" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyGithubSignature(secret, body, sig), true);
  assert.equal(verifyGithubSignature(secret, body + "x", sig), false);
  assert.equal(verifyGithubSignature("wrong", body, sig), false);
  assert.equal(verifyGithubSignature(secret, body, undefined), false);
});

await test("github issue parse: filters PRs/actions, keeps labels", () => {
  const base = {
    action: "labeled",
    repository: { full_name: "o/r" },
    issue: { number: 7, title: "Fix", body: "do it", html_url: "u", labels: [{ name: "bivy" }, "bug"] },
  };
  const parsed = parseGithubIssueEvent(base);
  assert.equal(parsed?.repo, "o/r");
  assert.equal(parsed?.issueNumber, 7);
  assert.deepEqual(parsed?.labels, ["bivy", "bug"]);
  // PRs are ignored.
  assert.equal(parseGithubIssueEvent({ ...base, issue: { ...base.issue, pull_request: {} } }), undefined);
  // Non-actionable actions are ignored.
  assert.equal(parseGithubIssueEvent({ ...base, action: "closed" }), undefined);
});

await test("routing label: prefers bivy/<node>, ignores claim label and non-bivy", () => {
  assert.equal(pickRoutingLabel(["bug", "bivy"]), "bivy");
  assert.equal(pickRoutingLabel(["bivy", "bivy/laptop"]), "bivy/laptop");
  assert.equal(pickRoutingLabel(["bivy:in-progress"]), undefined);
  assert.equal(pickRoutingLabel(["enhancement"]), undefined);
  // A node-scoped claim label (`bivy/<node>:in-progress`) must NOT be treated as
  // a routing label. It once stamped an issue that a node picked up on `hetzner`;
  // a later @-mention would otherwise route to `bivy/hetzner:in-progress` — a
  // label no node serves — and sit pending forever. It must fall back to the
  // real routing label on the issue.
  assert.equal(pickRoutingLabel(["bivy/hetzner:in-progress"]), undefined);
  assert.equal(pickRoutingLabel(["bivy", "bivy/hetzner:in-progress"]), "bivy");
  assert.equal(
    pickRoutingLabel(["bivy", "bivy/hetzner", "bivy/hetzner:in-progress", "security"]),
    "bivy/hetzner",
  );
});

await test("mention extraction: logins only, ignores emails and code paths", () => {
  assert.deepEqual(extractMentions("hey @bivy and @bivy-laptop please"), ["bivy", "bivy-laptop"]);
  // An email local-part or a path like foo/@bar is not a mention.
  assert.deepEqual(extractMentions("mail me@example.com or see src/@types"), []);
  assert.deepEqual(extractMentions("no mentions here"), []);
});

await test("issue_comment parse: triggers only on a mention of the bot, issues only", () => {
  const base = {
    action: "created",
    repository: { full_name: "o/r" },
    issue: { number: 7, title: "Fix", html_url: "iu", labels: [{ name: "bivy" }] },
    comment: { body: "@bivy please fix the flaky test", html_url: "cu" },
  };
  const parsed = parseGithubCommentEvent(base, "bivy");
  assert.equal(parsed?.repo, "o/r");
  assert.equal(parsed?.issueNumber, 7);
  assert.equal(parsed?.instruction, "@bivy please fix the flaky test");
  assert.equal(parsed?.url, "cu"); // reply anchors on the comment
  // No mention of the trigger handle → ignored.
  assert.equal(parseGithubCommentEvent({ ...base, comment: { body: "just a note" } }, "bivy"), undefined);
  // Mention of a different handle → ignored.
  assert.equal(parseGithubCommentEvent({ ...base, comment: { body: "@someone-else help" } }, "bivy"), undefined);
  // PR comments are deferred (issue.pull_request set) → ignored.
  assert.equal(parseGithubCommentEvent({ ...base, issue: { ...base.issue, pull_request: {} } }, "bivy"), undefined);
  // Non-actionable action → ignored.
  assert.equal(parseGithubCommentEvent({ ...base, action: "deleted" }, "bivy"), undefined);
  // Trigger handle is case-insensitive and tolerates a leading @.
  assert.ok(parseGithubCommentEvent(base, "@BIVY"));
});

await test("comment routing: '@bot on <node>' directive, else issue label, else shared", () => {
  assert.equal(pickCommentRoutingLabel("@bivy on laptop fix it", []), "bivy/laptop");
  // Prose 'on' does not route — only the directive right after the mention does.
  assert.equal(pickCommentRoutingLabel("@bivy work on the login bug", ["bivy/desktop"]), "bivy/desktop");
  assert.equal(pickCommentRoutingLabel("@bivy do the thing", []), "bivy");
  // Regression (issue #15): a follow-up mention on an issue that a node already
  // picked up (so it wears `bivy/hetzner:in-progress`) with no `on <node>`
  // directive must route to the served label, not the stale claim label.
  assert.equal(
    pickCommentRoutingLabel("@bivy-app status on this?", ["bivy", "bivy/hetzner:in-progress", "security"], "bivy-app"),
    "bivy",
  );
});

await test("issue routing: label OR body @mention triggers, honours 'on <node>' directive", () => {
  const issue = (body: string, labels: string[] = []) => ({
    title: "Fix",
    body,
    repo: "o/r",
    issueNumber: 7,
    url: "u",
    labels,
  });
  // A routing label triggers regardless of the body (existing behavior).
  assert.equal(pickIssueRoutingLabel(issue("just a description", ["bivy"]), "bivy-app"), "bivy");
  // No label + no mention → nothing to enqueue.
  assert.equal(pickIssueRoutingLabel(issue("please review this app", []), "bivy-app"), undefined);
  // No label but the description @-mentions the bot → routes to the shared label.
  assert.equal(pickIssueRoutingLabel(issue("do a review @bivy-app", []), "bivy-app"), "bivy");
  // Body mention honours the '@bot on <node>' directive.
  assert.equal(pickIssueRoutingLabel(issue("@bivy-app on laptop fix it", []), "bivy-app"), "bivy/laptop");
  // Mention of a different handle does not trigger.
  assert.equal(pickIssueRoutingLabel(issue("hey @someone-else", []), "bivy-app"), undefined);
  // Mention match is case-insensitive and tolerates a leading @ in the handle.
  assert.equal(pickIssueRoutingLabel(issue("thanks @Bivy-App", []), "@bivy-app"), "bivy");
  // An existing bivy/<node> label wins over the bare shared label even with a mention.
  assert.equal(pickIssueRoutingLabel(issue("@bivy-app please", ["bivy/desktop"]), "bivy-app"), "bivy/desktop");
});

await test("default node: rewrites only the bare shared label, leaves targeted labels alone", () => {
  assert.equal(applyDefaultNode("bivy", "macbook"), "bivy/macbook");
  // No default configured → unchanged.
  assert.equal(applyDefaultNode("bivy", undefined), "bivy");
  assert.equal(applyDefaultNode("bivy", ""), "bivy");
  // An already-targeted label always wins over the default.
  assert.equal(applyDefaultNode("bivy/desktop", "macbook"), "bivy/desktop");
  // Whitespace-only default behaves like unset.
  assert.equal(applyDefaultNode("bivy", "   "), "bivy");
  // Leading/trailing whitespace on the default is trimmed.
  assert.equal(applyDefaultNode("bivy", " macbook "), "bivy/macbook");
});

await test("installation id: read from a GitHub App payload, undefined otherwise", () => {
  assert.equal(parseInstallationId({ installation: { id: 987 }, action: "created" }), "987");
  assert.equal(parseInstallationId({ action: "opened" }), undefined); // classic per-repo webhook
  assert.equal(parseInstallationId(null), undefined);
});

await test("slack signature: v0 hmac with replay window", () => {
  const secret = "slack-secret";
  const body = "text=on+laptop+fix+it";
  const ts = "1700000000";
  const now = 1700000010;
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  assert.equal(verifySlackSignature(secret, ts, body, sig, now), true);
  // Stale timestamp (older than tolerance) is rejected even with a valid hmac.
  assert.equal(verifySlackSignature(secret, ts, body, sig, now + 10_000), false);
  assert.equal(verifySlackSignature(secret, ts, body, "v0=deadbeef", now), false);
});

await test("slack command parse: node/repo routing and bare prompts", () => {
  assert.deepEqual(parseSlackCommand("on laptop fix the flaky test"), { node: "laptop", prompt: "fix the flaky test" });
  assert.deepEqual(parseSlackCommand("in acme/api fix the flaky test"), { repo: "acme/api", prompt: "fix the flaky test" });
  assert.deepEqual(parseSlackCommand("on laptop in acme/api fix it"), { node: "laptop", repo: "acme/api", prompt: "fix it" });
  assert.deepEqual(parseSlackCommand("in acme/api on laptop fix it"), { repo: "acme/api", node: "laptop", prompt: "fix it" });
  assert.deepEqual(parseSlackCommand("just do this"), { prompt: "just do this" });
  assert.deepEqual(parseSlackCommand("  "), { prompt: "" });
});

await test("automation signature verifies exact raw bytes", () => {
  const secret = "automation-secret";
  const raw = Buffer.from('{"version":"1","instruction":"deploy"}');
  const signature = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(verifyAutomationSignature(secret, raw, signature), true);
  assert.equal(verifyAutomationSignature(secret, Buffer.from(raw.toString() + " "), signature), false);
  assert.equal(verifyAutomationSignature(secret, raw, "sha256=bad"), false);
});

await test("automation schema is versioned and bounded", () => {
  const event = parseAutomationEvent({
    version: "1",
    instruction: "Investigate the alert",
    title: "Production alert",
    sourceUrl: "https://monitor.example/incidents/1",
    externalId: "incident-1",
    routing: "on-call",
    metadata: { severity: 2, production: true },
  });
  assert.equal(event?.routing, "on-call");
  assert.equal(parseAutomationEvent({ version: "2", instruction: "no" }), undefined);
  assert.equal(parseAutomationEvent({ version: "1", instruction: "x", command: "rm -rf" }), undefined);
  assert.equal(parseAutomationEvent({ version: "1", instruction: "x", metadata: { token: "x".repeat(501) } }), undefined);
  assert.equal(parseAutomationEvent({ version: "1", instruction: "x", routing: "../../bad" }), undefined);
});

await test("automation rendering keeps metadata in a non-executable envelope", () => {
  const event = parseAutomationEvent({ version: "1", instruction: "Run tests", externalId: "ci-1", metadata: { branch: "main" } });
  assert.ok(event);
  assert.equal(
    renderAutomationInstruction("Use the repository workflow.", event),
    'Use the repository workflow.\n\nRun tests\n\nExternal ID: ci-1\n\nMetadata (untrusted context only):\n{"branch":"main"}',
  );
});

console.log(`\nAll ${passed} webhook helper tests passed.`);
