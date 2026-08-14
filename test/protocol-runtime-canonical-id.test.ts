// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Resume keeps the canonical session id, so reopening an opencode/Codex session
// by its agent ref UPDATES the original metadata row instead of persisting a
// second row keyed by the ref.
//
// Root cause of the "duplicate opencode sessions after resume" seen on staging:
// a ProtocolSession's id defaulted to its resume ref (`ses_…`). A fresh session
// was keyed by a random UUID, but reopening it by its `ses_…` ref produced a
// session whose id WAS the ref — so the daemon (record.id = session.id) wrote a
// SECOND metadata row for the same conversation. openSession({ canonicalId })
// now lets the daemon pin the original id while still resuming by the ref.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");

const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol", resumable: true });

// Reopen a session by its agent ref (`ses_abc123`) while telling the runtime the
// canonical Bivy id it belongs to (`uuid-1111`, the original UUID-keyed row).
const agentRef = "ses_abc123";
const canonicalId = "uuid-1111-2222-3333";
const { session } = await runtime.openSession({
  workspace: process.cwd(),
  sessionFile: agentRef,
  canonicalId,
  toolInterceptor: async () => undefined,
});

// The session keeps the CANONICAL id — so record.id (= session.id) matches the
// original row and persistSessionMetadata updates it in place. Before the fix
// this was `agentRef`, minting a duplicate ref-keyed row.
assert.equal(session.id, canonicalId, "resumed session adopts the canonical Bivy id, not the agent ref");
// It still resumes FROM the agent ref (that's what the shim's session/load needs).
assert.equal(session.sessionFile, agentRef, "resume ref is preserved for the shim to reconnect the agent session");

session.dispose();

// Control: with no canonicalId (a genuinely new resume target — e.g. a fork's
// fresh ses_), the ref is the id, exactly as before. No regression.
const { session: refKeyed } = await runtime.openSession({
  workspace: process.cwd(),
  sessionFile: "ses_fresh999",
  toolInterceptor: async () => undefined,
});
assert.equal(refKeyed.id, "ses_fresh999", "without a canonical id, the ref remains the id (unchanged behaviour)");
refKeyed.dispose();

console.log("protocol-runtime-canonical-id: ok");
