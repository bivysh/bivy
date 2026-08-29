import assert from "node:assert/strict";
import path from "node:path";

import { PI_CAPABILITIES } from "../src/agents/pi/capabilities.js";
import { LazyPiRuntime } from "../src/agents/pi/integration.js";
import { resolveResumeRef } from "../src/session-ref.js";

// Regression: the registry hands out LazyPiRuntime (so the pi SDK loads on first
// use), and the daemon reads capability flags off THAT object before any session
// is opened. Its capability table was a hand-copied duplicate of PiRuntime's that
// lost `sessionRefIsPath`, so runtimeResumesByPath("pi") reported id-based, the
// resume ref was stripped to a bare basename, and every prompt sent to a closed
// pi chat spawned a brand-new empty session instead of resuming the old one.
{
  const lazy = new LazyPiRuntime({ credsDir: "/tmp/creds", piDir: "/tmp/pi", sessionsDir: "/tmp/sessions", credentialOwner: "bivy" });
  assert.equal(lazy.capabilities, PI_CAPABILITIES, "LazyPiRuntime must expose the single shared Pi capability table");
  assert.equal(lazy.capabilities.sessionRefIsPath, true, "pi resumes by transcript path; the facade must say so");
  assert.equal(lazy.capabilities.resume, true);
  assert.equal(lazy.capabilities.forkTransport, true);
  assert.equal(lazy.capabilities.forkHistoryImport, true);
  assert.equal(lazy.capabilities.sessionDiscovery, true);
}

// End-to-end on the ref layer: with the facade's flags, a stored pi transcript
// path must resolve to itself (guarded), never to a bare id-like basename.
{
  const sessionsDir = path.join(path.sep, "home", "u", ".bivy", "pi", "sessions");
  const ref = path.join(sessionsDir, "2026-08-29T18-37-49-345Z_01a04ed0-4da1-700a-9124-314ea76f4fd2.jsonl");
  const resumesByPath = PI_CAPABILITIES.sessionRefIsPath === true;
  assert.equal(resolveResumeRef({ ref, resumesByPath, sessionsDir }), ref);
}
