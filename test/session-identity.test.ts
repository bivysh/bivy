import assert from "node:assert/strict";
import { dedupeSessionSummaries, type OwnedSessionSummary, type SessionIdentityOwner } from "../src/session-identity.js";

const sharedRef = "/tmp/codex/sessions/rollout-abc.jsonl";
const sessions: OwnedSessionSummary[] = [
  { id: "exec-local-id", path: sharedRef, agent: "codex", agentName: "Codex", name: "Fix duplicate sessions" },
  { id: "thread-abc", path: sharedRef, agent: "codex-approvals", agentName: "Codex", name: "Fix duplicate sessions" },
  { id: "other", path: "/tmp/codex/sessions/rollout-other.jsonl", agent: "codex-approvals", agentName: "Codex" },
];
const owner: SessionIdentityOwner = { id: "thread-abc", path: sharedRef, runtimeId: "codex-approvals" };
const result = dedupeSessionSummaries(sessions, (session) => session.path === sharedRef ? owner : undefined);
assert.deepEqual(result.map((session) => session.id), ["thread-abc", "other"]);

const idOnly = dedupeSessionSummaries([
  { id: "one", agent: "pi", agentName: "Pi" },
  { id: "two", agent: "pi", agentName: "Pi" },
], () => undefined);
assert.deepEqual(idOnly.map((session) => session.id), ["one", "two"]);

console.log("session-identity: all tests passed");
