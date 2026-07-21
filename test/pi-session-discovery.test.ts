import assert from "node:assert/strict";
import path from "node:path";
import { discoverPiSessionForCwd } from "../src/runtime/pi-session-discovery.js";
import type { SessionSummary } from "../src/runtime/types.js";

const cwd = path.resolve("/tmp/bivy-pi-discovery-workspace");
const startedAt = Date.now();
const sessions: SessionSummary[] = [
  { id: "other-cwd", path: "/sessions/other.jsonl", cwd: path.resolve("/tmp/other"), created: new Date(startedAt + 10) },
  { id: "old-same-cwd", path: "/sessions/old.jsonl", cwd, created: new Date(startedAt - 60_000) },
  // Pi can create the header just before TerminalManager records createdAt.
  { id: "matching", path: "/sessions/matching.jsonl", cwd, created: new Date(startedAt - 5), modified: new Date(startedAt + 100) },
  { id: "later", path: "/sessions/later.jsonl", cwd, created: new Date(startedAt + 2_000) },
];

const match = discoverPiSessionForCwd(sessions, cwd, startedAt);
assert.equal(match?.id, "matching", "chooses the same-workspace Pi session nearest terminal creation");
assert.equal(discoverPiSessionForCwd(sessions, path.resolve("/tmp/missing"), startedAt), undefined, "does not adopt another workspace's session");
assert.equal(discoverPiSessionForCwd(sessions, cwd, Number.NaN), undefined, "rejects an invalid terminal timestamp");

console.log("pi-session-discovery: ok");
