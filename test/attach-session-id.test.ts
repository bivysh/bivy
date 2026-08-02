// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #290: unlike Claude Code, ProcessRuntime, and ProtocolRuntime (see
// process-runtime-attach-env.test.ts / protocol-runtime-attach-env.test.ts /
// claude-attach-prompt.test.ts), the pi adapter runs its agent loop in-process
// rather than under a subprocess Bivy controls, so it has no hook to inject
// BIVY_SESSION_ID into its own bash tool's env. resolveAttachSessionId
// (bin/attach-session-id.mjs, used by `bivy attach` — bin/bivy.mjs's cmdAttach)
// closes that gap by also accepting $PI_SESSION_ID, which the pi-coding-agent
// SDK's bash tool already exposes to every command it runs, and which is the
// exact same id as the Bivy session (see the comment on
// PiSession.interactiveTuiCommand in src/runtime/pi.ts).

import assert from "node:assert/strict";
import { resolveAttachSessionId } from "../bin/attach-session-id.mjs";

// --session flag always wins, over either env var.
assert.equal(
  resolveAttachSessionId({ sessionFlag: "explicit-id", env: { BIVY_SESSION_ID: "bivy-id", PI_SESSION_ID: "pi-id" } }),
  "explicit-id",
);

// The universal path: BIVY_SESSION_ID (injected by every subprocess-spawning
// adapter) is used when no flag is given.
assert.equal(resolveAttachSessionId({ env: { BIVY_SESSION_ID: "bivy-id" } }), "bivy-id");

// BIVY_SESSION_ID wins over PI_SESSION_ID when both happen to be set.
assert.equal(resolveAttachSessionId({ env: { BIVY_SESSION_ID: "bivy-id", PI_SESSION_ID: "pi-id" } }), "bivy-id");

// The pi fallback: no BIVY_SESSION_ID, but the pi-coding-agent SDK's own
// PI_SESSION_ID is present (and is the real Bivy session id for a pi session).
assert.equal(resolveAttachSessionId({ env: { PI_SESSION_ID: "pi-id" } }), "pi-id");

// Nothing set anywhere → undefined (the CLI then prints the "no session id" error).
assert.equal(resolveAttachSessionId({ env: {} }), undefined);
assert.equal(resolveAttachSessionId({}), undefined);
assert.equal(resolveAttachSessionId(), undefined);

// Blank/whitespace-only values are treated as absent, not as a literal session id.
assert.equal(resolveAttachSessionId({ sessionFlag: "  ", env: { BIVY_SESSION_ID: "  ", PI_SESSION_ID: "pi-id" } }), "pi-id");

console.log("attach-session-id: all tests passed");
