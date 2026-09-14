import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listNativePiSessions } from "../src/agents/pi/integration.js";
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

// `bivy run pi` writes to the operator's native Pi store, not Bivy's governed
// sessions directory. Ensure takeover's list source reads that native store.
const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-native-pi-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = nativeRoot;
try {
  const nativeWorkspace = path.join(nativeRoot, "workspace");
  fs.mkdirSync(nativeWorkspace);
  // Use Pi's real default layout: sessions/<encoded-cwd>/*.jsonl. Passing the
  // sessions root explicitly would create a flat test-only layout and miss the
  // takeover regression where listAll(customRoot) does not scan subdirectories.
  const manager = SessionManager.create(nativeWorkspace);
  manager.appendMessage({ role: "user", content: "hello from native pi", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
  const listed = await listNativePiSessions();
  assert.ok(listed.some((session) => session.id === manager.getSessionId() && session.cwd === nativeWorkspace), "lists the native Pi TUI session");
} finally {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  fs.rmSync(nativeRoot, { recursive: true, force: true });
}

console.log("pi-session-discovery: ok");
