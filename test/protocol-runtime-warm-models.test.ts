import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";

// warmModels() on the generic protocol runtime — the sibling of Claude Code's
// warmModels(). A draft/new-session picker for any protocol agent (Codex, Gemini,
// opencode, …) should show the real list before the first prompt.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");

// ── Late-models (ACP) agent: the list arrives with session/new, not hello ──
// createSession() only start()s the shim (waits for hello), so the picker is
// empty until a session opens. This is the case warmModels() exists for.
{
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture ACP",
    env: { FIXTURE_LATE_MODELS: "1" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  // The shim spawned (hello handshake) but advertised no models there — an ACP
  // agent can't know them until a session opens, so the draft picker is empty.
  assert.deepEqual(await session.getModels(), [], "a late-models agent lists nothing before a session opens");

  // Warming opens a session (session.create), which is when the shim publishes
  // the authoritative, provider-dependent list.
  await session.warmModels();
  assert.deepEqual(
    (await session.getModels()).map((m) => m.id),
    ["acp-pro", "acp-lite"],
    "warmModels() opens a session so the late runtime.models registry lands",
  );

  session.dispose();
  console.log("protocol warmModels (late/ACP) OK");
}

// ── Hello-advertised agent (Codex-style): already warm, no session opened ──
// The shim advertises its list in hello, which createSession's start() waited on.
// warmModels() must NOT open a throwaway session just to re-learn what it has.
{
  const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Hello" });
  const { session } = await runtime.createSession({ workspace: process.cwd() });

  assert.deepEqual(
    (await session.getModels()).map((m) => m.id),
    ["fixture-small", "fixture-large"],
    "a hello-advertised agent lists its models straight after createSession",
  );
  assert.equal((session as { sessionFile?: string }).sessionFile, undefined, "no session opened yet");

  await session.warmModels();
  assert.equal(
    (session as { sessionFile?: string }).sessionFile,
    undefined,
    "warmModels() is a no-op when hello already carried the list — no throwaway session.create",
  );

  session.dispose();
  console.log("protocol warmModels (hello) OK");
}

// ── Idempotence: warming an already-open session is a no-op, not a respawn ──
{
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture ACP",
    env: { FIXTURE_LATE_MODELS: "1" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  await session.warmModels();
  const pid = session.activePid();
  assert.ok(pid !== undefined, "warmModels() left the shim running for the first prompt to reuse");
  await session.warmModels();
  assert.equal(session.activePid(), pid, "warmModels() is idempotent once the session is up");
  session.dispose();
  console.log("protocol warmModels idempotent OK");
}

console.log("protocol warmModels: all tests passed");
