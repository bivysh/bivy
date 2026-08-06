// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #290: pi (src/runtime/pi.ts) is the one adapter whose agent loop runs
// in-process rather than under a subprocess Bivy controls (see the comment on
// PiSession.interactiveTuiCommand), so it can't inject BIVY_SESSION_ID into its
// bash tool's env the way Claude Code / ProcessRuntime / ProtocolRuntime do (see
// claude-attach-prompt.test.ts / process-runtime-attach-env.test.ts /
// protocol-runtime-attach-env.test.ts). The one subprocess pi.ts DOES configure
// itself is the interactive-TUI hand-off; this locks in that it carries
// BIVY_SESSION_ID too, matching the session's own id. The live-chat gap is
// closed separately, via the PI_SESSION_ID fallback in bin/attach-session-id.mjs
// (see attach-session-id.test.ts).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-attach-env-"));
const sessionsDir = path.join(piDir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir });
const { session } = await runtime.createSession({ workspace: piDir });

// SessionManager.create() assigns a session file synchronously (before any
// prompt), so a fresh session already has one to resume into the TUI.
assert.ok(session.sessionFile, "expected a session file to already be assigned");

const spec = await session.interactiveTuiCommand?.();
assert.ok(spec, "expected a TUI launch spec");
assert.equal(spec!.env?.BIVY_SESSION_ID, session.id, "BIVY_SESSION_ID must be in the TUI subprocess env, matching the session id");

session.dispose();
fs.rmSync(piDir, { recursive: true, force: true });

console.log("pi-attach-env: ok");
