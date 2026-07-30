import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import { buildForkBundle, materializeFork, resolveForkFidelity } from "../src/session/fork.js";
import type { ForkRecord } from "../src/session/fork.js";
import type { AgentRuntime } from "../src/runtime/types.js";

// End-to-end tests for the session-fork transport seam (docs/session-fork-plan.md):
// same-runtime forks are full fidelity (native export -> import on a "second
// node"); cross-runtime forks fall back to a seeded continuation prompt.

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`✓ ${name}`);
  });
}

const record = (over: Partial<ForkRecord> = {}): ForkRecord => ({
  sourceSessionId: "src-1",
  runtimeId: "pi",
  workspace: "/tmp/forkproj",
  cwd: "/tmp/forkproj",
  title: "Fix the parser",
  model: "claude-sonnet",
  ...over,
});

async function run() {
  // --- pi -> pi across two "nodes": full fidelity via native replay ----------
  await test("pi->pi fork is full fidelity and replays the transcript on the destination", async () => {
    const srcPiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-src-"));
    const srcSessions = path.join(srcPiDir, "sessions");
    fs.mkdirSync(srcSessions, { recursive: true });
    const sm = SessionManager.create(process.cwd(), srcSessions);
    sm.appendMessage({ role: "user", content: "make it faster" });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "on it" }] });
    const sessionFile = sm.getSessionFile()!;

    const srcPi = new PiRuntime({ credsDir: srcPiDir, piDir: srcPiDir, sessionsDir: srcSessions });
    const bundle = buildForkBundle({ runtime: srcPi, sessionFile, record: record() });
    assert.ok(bundle.native, "pi supports native fork transport");
    assert.equal(bundle.native!.runtimeId, "pi");
    assert.equal(bundle.normalized.turns.length, 2, "normalized transcript is always captured too");

    // A separate sessions dir stands in for the destination node's store.
    const dstPiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-dst-"));
    const dstSessions = path.join(dstPiDir, "sessions");
    fs.mkdirSync(dstSessions, { recursive: true });
    const dstPi = new PiRuntime({ credsDir: dstPiDir, piDir: dstPiDir, sessionsDir: dstSessions });

    const plan = await materializeFork({ bundle, targetRuntime: dstPi, ctx: { workspace: process.cwd(), cwd: process.cwd() } });
    assert.equal(plan.kind, "resume");
    assert.equal(plan.fidelity, "full");
    assert.notEqual((plan as { sessionFile: string }).sessionFile, sessionFile, "a new session file is created, source untouched");

    const replayed = dstPi.readMessages((plan as { sessionFile: string }).sessionFile);
    assert.ok(replayed, "destination session is readable");
    assert.deepEqual(replayed!.map((m) => (m as { role: string }).role), ["user", "assistant"]);

    // Source session is intact.
    assert.equal(srcPi.readMessages(sessionFile)!.length, 2, "source transcript is not mutated by the fork");
  });

  // --- claude -> claude across two config dirs: full fidelity via jsonl -------
  await test("claude->claude fork rewrites the jsonl under a fresh id on the destination", async () => {
    const srcHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-claude-src-"));
    const projectDir = path.join(srcHome, "projects", "-home-user-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const srcId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const jsonl = [
      { type: "user", sessionId: srcId, cwd: "/home/user/proj", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00Z" },
      { type: "assistant", sessionId: srcId, message: { role: "assistant", content: [{ type: "text", text: "hey" }] }, timestamp: "2026-01-01T00:00:01Z" },
    ].map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(path.join(projectDir, `${srcId}.jsonl`), `${jsonl}\n`);

    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = srcHome;
      const srcClaude = new ClaudeCodeRuntime();
      const bundle = buildForkBundle({ runtime: srcClaude, sessionFile: srcId, record: record({ runtimeId: "claude-code-sdk" }) });
      assert.ok(bundle.native, "claude supports native fork transport");
      assert.equal(bundle.native!.runtimeId, "claude-code-sdk");

      // Destination node = a different config dir.
      const dstHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-claude-dst-"));
      process.env.CLAUDE_CONFIG_DIR = dstHome;
      const dstClaude = new ClaudeCodeRuntime();
      const cwd = "/home/user/moved";
      const plan = await materializeFork({ bundle, targetRuntime: dstClaude, ctx: { workspace: cwd, cwd } });
      assert.equal(plan.kind, "resume");
      assert.equal(plan.fidelity, "full");
      const newId = (plan as { sessionFile: string }).sessionFile;
      assert.notEqual(newId, srcId, "a fresh session id is minted");

      // The file lands under the destination cwd's encoded project dir...
      const expectedFile = path.join(dstHome, "projects", "-home-user-moved", `${newId}.jsonl`);
      assert.ok(fs.existsSync(expectedFile), "jsonl written under the destination cwd's project dir");
      // ...with every entry's sessionId rewritten to the new id.
      for (const line of fs.readFileSync(expectedFile, "utf8").split(/\r?\n/).filter(Boolean)) {
        assert.equal(JSON.parse(line).sessionId, newId, "each entry's sessionId is rewritten");
      }
      // And the transcript reads back through the normal path.
      const replayed = dstClaude.readMessages(newId);
      assert.equal(replayed!.length, 2, "destination transcript reads back");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  // --- pi -> claude: a TRUE cross-runtime fork replays the whole transcript ----
  await test("cross-runtime fork (pi->claude) is replayed: the full transcript is materialised as claude history", async () => {
    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-x-"));
    const sessions = path.join(piDir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sm = SessionManager.create(process.cwd(), sessions);
    sm.appendMessage({ role: "user", content: "port this to rust" });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "starting the port" }] });
    const sessionFile = sm.getSessionFile()!;
    const pi = new PiRuntime({ credsDir: piDir, piDir, sessionsDir: sessions });
    const bundle = buildForkBundle({ runtime: pi, sessionFile, record: record({ branch: "bivy/port" }), targetRuntimeId: "claude-code-sdk" });

    const dstHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-x-claude-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = dstHome;
      const claude = new ClaudeCodeRuntime();
      assert.equal(resolveForkFidelity(bundle, claude), "replayed", "a claude target can import portable history");
      const cwd = "/home/user/ported";
      const plan = await materializeFork({ bundle, targetRuntime: claude, ctx: { workspace: cwd, cwd } });
      assert.equal(plan.kind, "resume", "a replayed fork resumes a materialised session, it does not seed a prompt");
      assert.equal(plan.fidelity, "replayed");
      const newId = (plan as { sessionFile: string }).sessionFile;

      // The synthesised jsonl reads back as the full conversation, in order.
      const replayed = claude.readMessages(newId)!;
      assert.equal(replayed.length, 2, "the whole transcript is materialised, not a summary");
      assert.deepEqual(replayed.map((m) => (m as { role: string }).role), ["user", "assistant"]);
      const first = replayed[0] as { content: unknown };
      assert.ok(String(first.content).includes("port this to rust"), "the original prose is preserved verbatim");

      // Source pi session is untouched by the cross-runtime fork.
      assert.equal(pi.readMessages(sessionFile)!.length, 2, "source transcript is not mutated");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  // --- fallback: a target with no history import still seeds a prompt ----------
  await test("cross-runtime fork to a runtime without forkHistoryImport falls back to a seeded prompt", async () => {
    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-fork-seed-"));
    const sessions = path.join(piDir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sm = SessionManager.create(process.cwd(), sessions);
    sm.appendMessage({ role: "user", content: "port this to rust" });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "starting the port" }] });
    const pi = new PiRuntime({ credsDir: piDir, piDir, sessionsDir: sessions });
    const bundle = buildForkBundle({ runtime: pi, sessionFile: sm.getSessionFile()!, record: record({ branch: "bivy/port" }), targetRuntimeId: "legacy-shim" });

    // A runtime that can neither replay a pi native payload nor import history.
    const shim = fakeRuntime("legacy-shim", false);
    assert.equal(resolveForkFidelity(bundle, shim), "seeded", "no native import + no history import => seeded");
    const plan = await materializeFork({
      bundle,
      targetRuntime: shim,
      ctx: { workspace: "/tmp/x", cwd: "/tmp/x" },
      seed: { transcriptUrl: "https://app.example/sessions/src-1" },
    });
    assert.equal(plan.kind, "seed");
    assert.equal(plan.fidelity, "seeded");
    const seedPrompt = (plan as { seedPrompt: string }).seedPrompt;
    assert.ok(seedPrompt.includes("port this to rust"), "recent turns are inlined");
    assert.ok(seedPrompt.includes("Branch: bivy/port"), "carried context appears");
    assert.ok(seedPrompt.includes("https://app.example/sessions/src-1"), "link to the full transcript");
  });

  // --- fidelity gating on capability, not just id -----------------------------
  await test("a same-id target without forkTransport still resolves to seeded", () => {
    const bundle = buildForkBundle({
      runtime: fakeRuntime("pi", true),
      sessionFile: "x",
      record: record(),
    });
    assert.equal(resolveForkFidelity(bundle, fakeRuntime("pi", false)), "seeded", "no forkTransport => seeded");
    assert.equal(resolveForkFidelity(bundle, fakeRuntime("pi", true)), "full", "same id + forkTransport => full");
    assert.equal(resolveForkFidelity(bundle, fakeRuntime("other", true)), "seeded", "different runtime, no history import => seeded");
    // A different runtime that CAN import portable history is a true (replayed) fork.
    assert.equal(resolveForkFidelity(bundle, fakeRuntime("other", false, true)), "replayed", "different runtime + forkHistoryImport => replayed");
    // Native import still wins over history replay for a same-runtime target.
    assert.equal(resolveForkFidelity(bundle, fakeRuntime("pi", true, true)), "full", "same runtime prefers full over replayed");
  });

  // --- agent-aware export: drop the unusable native payload cross-runtime -----
  await test("a fork targeting a different agent omits the native payload it could never replay", () => {
    const src = fakeRuntime("pi", true);
    // Target not yet known => keep native (destination may match, wants full fidelity).
    assert.ok(buildForkBundle({ runtime: src, sessionFile: "x", record: record() }).native, "unknown target keeps native");
    // Same runtime chosen => keep native (full-fidelity replay is possible).
    assert.ok(
      buildForkBundle({ runtime: src, sessionFile: "x", record: record(), targetRuntimeId: "pi" }).native,
      "same-runtime target keeps native",
    );
    // Different runtime chosen => drop native (it can never round-trip there)...
    const cross = buildForkBundle({ runtime: src, sessionFile: "x", record: record(), targetRuntimeId: "claude-code-sdk" });
    assert.equal(cross.native, undefined, "cross-runtime target omits native");
    // ...but the normalized seed is always present, so the fork still works.
    assert.ok(cross.normalized.turns.length > 0, "normalized seed survives so the seeded fork still has history");
  });

  console.log(`fork-transport: all ${passed} tests passed`);
}

/** Minimal AgentRuntime stand-in for capability-gating assertions. */
function fakeRuntime(id: string, forkTransport: boolean, forkHistoryImport = false): AgentRuntime {
  return {
    id,
    displayName: id,
    capabilities: { toolInterception: false, modelSelection: false, packages: false, resume: true, fork: false, forkTransport, forkHistoryImport },
    createSession: async () => { throw new Error("unused"); },
    openSession: async () => { throw new Error("unused"); },
    listSessions: async () => [],
    readMessages: () => [{ role: "user", content: "seed me" }],
    exportForFork: forkTransport ? () => ({ runtimeId: id, kind: "fake", data: {} }) : undefined,
    importForFork: forkTransport ? async () => ({ sessionFile: "new", id: "new" }) : undefined,
    importHistoryForFork: forkHistoryImport ? async () => ({ sessionFile: "hist", id: "hist" }) : undefined,
  } as AgentRuntime;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
