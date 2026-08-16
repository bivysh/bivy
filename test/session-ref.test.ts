import assert from "node:assert/strict";
import path from "node:path";
import { resolveResumeRef, resumeRefFor, sessionIdFromRef, storedResumeRef } from "../src/session-ref.js";

const sessionsDir = "/home/user/.bivy/pi/sessions";

// --- sessionIdFromRef: normalizing an id-based runtime's resume ref ---

// A bare session id (the common case — straight from Bivy's metadata store).
assert.equal(sessionIdFromRef("6f1c2d34-abcd-1234-9999-0badc0ffee11"), "6f1c2d34-abcd-1234-9999-0badc0ffee11");
// An on-disk transcript path (Claude Code lists sessions from ~/.claude as <id>.jsonl).
assert.equal(
  sessionIdFromRef("/home/user/.claude/projects/-home-user-mesh/6f1c2d34-abcd.jsonl"),
  "6f1c2d34-abcd",
);
// Case-insensitive extension.
assert.equal(sessionIdFromRef("/tmp/abc.JSONL"), "abc");

// --- resolveResumeRef: id-based runtimes (Claude Code) must NOT hit the guard ---

// This is the regression: a Claude Code session id resumed from the PWA used to
// throw "Session file is outside the sessions directory" because it was resolved
// against pi's sessions dir. It must now pass straight through as the id.
assert.equal(
  resolveResumeRef({ ref: "6f1c2d34-abcd", resumesByPath: false, sessionsDir }),
  "6f1c2d34-abcd",
);
// Even when the id-based ref arrives as an absolute transcript path far outside
// pi's sessions dir, it resolves to the bare id — no throw.
assert.equal(
  resolveResumeRef({ ref: "/home/user/.claude/projects/x/6f1c2d34-abcd.jsonl", resumesByPath: false, sessionsDir }),
  "6f1c2d34-abcd",
);

// --- resolveResumeRef: path-based runtimes (pi) keep the traversal guard ---

// A legitimate pi session file under the sessions dir resolves to its absolute path.
const piFile = path.join(sessionsDir, "session-123.jsonl");
assert.equal(resolveResumeRef({ ref: piFile, resumesByPath: true, sessionsDir }), path.resolve(piFile));

// An arbitrary path escaping the sessions dir is still rejected.
assert.throws(
  () => resolveResumeRef({ ref: "/etc/passwd", resumesByPath: true, sessionsDir }),
  /outside the sessions directory/,
);
// Traversal via "../" is rejected.
assert.throws(
  () => resolveResumeRef({ ref: path.join(sessionsDir, "../../etc/passwd"), resumesByPath: true, sessionsDir }),
  /outside the sessions directory/,
);
// A sibling directory sharing the sessions-dir prefix must not slip past the guard
// (this is why the guard appends a path separator).
assert.throws(
  () => resolveResumeRef({ ref: `${sessionsDir}-evil/leak.jsonl`, resumesByPath: true, sessionsDir }),
  /outside the sessions directory/,
);

// --- storedResumeRef: direct create/open callers also honor metadata --------

assert.equal(
  storedResumeRef("pi-id", { id: "pi-id", path: "/home/user/.bivy/pi/sessions/pi.jsonl" }),
  "/home/user/.bivy/pi/sessions/pi.jsonl",
);
assert.equal(storedResumeRef("bivy-codex-id", { id: "bivy-codex-id", path: "native-thread-id" }), "native-thread-id");
// A metadata lookup by path can return the same row; an explicit path remains authoritative.
assert.equal(
  storedResumeRef("/explicit/session.jsonl", { id: "pi-id", path: "/stored/session.jsonl" }),
  "/explicit/session.jsonl",
);
assert.equal(storedResumeRef("claude-id", { id: "claude-id" }), "claude-id");

// --- resumeRefFor: decide what to resume a not-open session from -----------
//
// The server resumes a client-named session that isn't held in memory instead of
// failing with "Session not found" (the PWA's start/resume regression). These
// assert the ref it resumes from, and — critically — that a genuinely unknown
// session yields no ref (so it stays "not found" rather than resurrecting junk).

// An explicit transcript path always wins (a pi session file the client knows).
assert.equal(
  resumeRefFor({ id: "s1", path: "/home/user/.bivy/pi/sessions/s1.jsonl", metaPath: "/other", metaKnown: true }),
  "/home/user/.bivy/pi/sessions/s1.jsonl",
);
// No path → fall back to the path durable metadata recorded (pi after restart).
assert.equal(
  resumeRefFor({ id: "s1", metaPath: "/home/user/.bivy/pi/sessions/s1.jsonl", metaKnown: true }),
  "/home/user/.bivy/pi/sessions/s1.jsonl",
);
// Id-based runtime (Claude Code): metadata knows the session but records no
// path, so the id itself is the resume ref.
assert.equal(resumeRefFor({ id: "claude-uuid", metaKnown: true }), "claude-uuid");
// A whitespace-only path is ignored, not treated as an explicit ref.
assert.equal(resumeRefFor({ id: "claude-uuid", path: "  ", metaKnown: true }), "claude-uuid");
// Unknown session, no path → undefined (caller surfaces "Session not found").
assert.equal(resumeRefFor({ id: "ghost", metaKnown: false }), undefined);
// No id and no path → undefined (nothing to target).
assert.equal(resumeRefFor({ metaKnown: false }), undefined);
// A path with no metadata still resumes by that path (legacy/local open).
assert.equal(resumeRefFor({ path: "/some/where/s.jsonl", metaKnown: false }), "/some/where/s.jsonl");

console.log("session-ref: all tests passed");
