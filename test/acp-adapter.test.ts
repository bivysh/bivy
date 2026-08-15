// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// #2 — the GENERAL ACP adapter. Drives a stub Agent Client Protocol agent
// (test/fixtures/acp-agent.mjs) through bin/acp-shim.mjs → ProtocolRuntime, exactly
// as `BIVY_RUNTIME=acp BIVY_ACP_COMMAND=<agent>` would in production, and asserts
// the shim delivers streaming text, surfaces a tool permission as a governed
// tool.call, forwards the human's decision back as the ACP selected option, and
// finishes the turn. Runs in CI with no real ACP agent installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRuntime, listRegisteredAgents, listRuntimes, invalidateCliProbeCache } from "../src/runtime/index.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const acpAgent = path.join(__dirname, "fixtures/acp-agent.mjs");

function waitFor(events: RuntimeEvent[], pred: (e: RuntimeEvent) => boolean, timeoutMs = 6000): Promise<RuntimeEvent> {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const e = events.find(pred);
      if (e) { clearInterval(timer); resolve(e); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for ACP event")); }
    }, 10);
  });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${(e as Error).stack ?? (e as Error).message}`); }
}

// The `acp` runtime is a hidden catalog entry (opt-in via env), not in the picker.
await check("acp: catalog entry exists but stays out of the picker until configured", () => {
  assert.ok(listRegisteredAgents().some((r) => r.id === "acp"), "acp must be in the registry");
  assert.ok(!listRuntimes().some((r) => r.id === "acp"), "acp must be hidden from the picker (opt-in)");
});

await check("acp: makeRuntime throws a clear error without BIVY_ACP_COMMAND", () => {
  delete process.env.BIVY_ACP_COMMAND;
  assert.throws(() => makeRuntime({ runtime: "acp", credsDir: __dirname, piDir: __dirname, sessionsDir: __dirname }), /BIVY_ACP_COMMAND/);
});

await check("acp: drives a stub ACP agent — streaming, governed tool call, resume-capable", async () => {
  // Point the shim at the stub ACP agent: BIVY_ACP_COMMAND is `node`, args run the
  // fixture. The shim's own `--agent … -- …` wiring is built by acpRuntimeFromEnv.
  process.env.BIVY_ACP_COMMAND = process.execPath;
  process.env.BIVY_ACP_ARGS = JSON.stringify([acpAgent]);
  try {
    const runtime = makeRuntime({ runtime: "acp", credsDir: __dirname, piDir: __dirname, sessionsDir: __dirname });
    assert.equal(runtime.capabilities.toolInterception, true, "ACP runtime is governed");
    assert.equal(runtime.capabilities.resume, true, "ACP runtime advertises resume");

    const decisions: Array<{ toolName: string }> = [];
    const { session } = await runtime.createSession({
      workspace: __dirname,
      toolInterceptor: async (ctx) => { decisions.push(ctx as { toolName: string }); return undefined; }, // allow
    });

    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.prompt("hello acp");
    await waitFor(events, (e) => e.type === "agent_end");

    // Assistant text streamed via agent_message_chunk → message_update.
    const text = events.filter((e) => e.type === "message_update").map((e) => (e as any).message?.content).filter((c: unknown) => typeof c === "string").join("");
    assert.match(text, /Hello from ACP/, `expected streamed assistant text, got: ${text}`);

    // The ACP permission request surfaced as a governed tool.call the interceptor saw.
    assert.equal(decisions.length, 1, "the tool permission reached the interceptor");
    assert.ok(events.some((e) => e.type === "tool_call"), "tool_call surfaced");
    // Granting it let the agent report the tool completed, then finish the turn.
    assert.ok(events.some((e) => e.type === "tool_result"), "tool_result surfaced after approval");
    assert.equal(events.filter((e) => e.type === "agent_end").length, 1, "exactly one agent_end");

    session.dispose();
  } finally {
    delete process.env.BIVY_ACP_COMMAND;
    delete process.env.BIVY_ACP_ARGS;
  }
});

// 3A: Bivy's configured MCP servers must reach the ACP agent on session/new
// (they were hardcoded to [] in the shim, cutting ACP agents off from MCP).
await check("acp: forwards BIVY_ACP_MCP_SERVERS to the agent on session/new", async () => {
  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-acp-mcp-")), "servers.json");
  process.env.BIVY_ACP_COMMAND = process.execPath;
  process.env.BIVY_ACP_ARGS = JSON.stringify([acpAgent]);
  process.env.BIVY_TEST_MCP_DUMP = dump;
  const servers = [{ name: "bivy", command: "bivy", args: ["mcp-serve"] }];
  process.env.BIVY_ACP_MCP_SERVERS = JSON.stringify(servers);
  try {
    const runtime = makeRuntime({ runtime: "acp", credsDir: __dirname, piDir: __dirname, sessionsDir: __dirname });
    const { session } = await runtime.createSession({ workspace: __dirname, toolInterceptor: async () => undefined });
    // session/new is created lazily on the first prompt; drive one turn so it fires.
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.prompt("hello acp");
    await waitFor(events, (e) => e.type === "agent_end");
    for (let i = 0; i < 300 && !fs.existsSync(dump); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(dump), "the stub agent recorded its session/new mcpServers");
    const received = JSON.parse(fs.readFileSync(dump, "utf8"));
    assert.deepEqual(received, servers, "the configured MCP servers reached the ACP agent verbatim");
    session.dispose();
  } finally {
    delete process.env.BIVY_ACP_COMMAND;
    delete process.env.BIVY_ACP_ARGS;
    delete process.env.BIVY_TEST_MCP_DUMP;
    delete process.env.BIVY_ACP_MCP_SERVERS;
  }
});

// opencode's ACP server resolves session/prompt BEFORE its final
// agent_message_chunk frames are flushed (the end_turn race, opencode#17505), so a
// naive client finalizes the turn with the reply's tail still unstreamed — the
// interim message streams live but is missing the moment the session reopens. The
// shim must hold session.done until the trailing updates drain, so the tail lands
// in the persisted transcript (getMessages), not just the live stream.
await check("acp: trailing agent_message_chunk after the prompt reply is drained into history, not lost", async () => {
  process.env.BIVY_ACP_COMMAND = process.execPath;
  process.env.BIVY_ACP_ARGS = JSON.stringify([acpAgent]);
  process.env.ACP_TRAILING_CHUNK = "1";
  try {
    const runtime = makeRuntime({ runtime: "acp", credsDir: __dirname, piDir: __dirname, sessionsDir: __dirname });
    const { session } = await runtime.createSession({ workspace: __dirname, toolInterceptor: async () => undefined });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.prompt("hello acp");
    await waitFor(events, (e) => e.type === "agent_end");
    // Live: the tail streamed (it is an interim message on the way).
    const streamed = events.filter((e) => e.type === "message_update").map((e) => (e as any).message?.content).filter((c: unknown) => typeof c === "string").join("");
    assert.match(streamed, /trailing tail that must survive reopen/, `tail should stream live, got: ${streamed}`);
    // Persisted: the same tail is folded into the assistant message getMessages()
    // returns — what the daemon snapshots to the base transcript on message_end,
    // so a re-opened session still shows it.
    const assistant = session.getMessages().find((m) => m.role === "assistant") as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = (assistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    assert.match(text, /trailing tail that must survive reopen/, `tail must persist to history, got: ${text}`);
    // The turn ends exactly once — the drained tail is not a second turn.
    assert.equal(events.filter((e) => e.type === "agent_end").length, 1, "exactly one agent_end after draining the tail");
    session.dispose();
  } finally {
    delete process.env.BIVY_ACP_COMMAND;
    delete process.env.BIVY_ACP_ARGS;
    delete process.env.ACP_TRAILING_CHUNK;
  }
});

// Per-agent ACP PROMOTION: an agent that declares `acp` (Gemini) is driven through
// the governed ProtocolRuntime — not the one-shot pipe — when BIVY_GEMINI_ACP=1,
// and honestly advertises the upgraded capabilities. This is the data-driven "make
// ACP the way we wrap this agent" switch.
await check("gemini: BIVY_GEMINI_ACP=1 promotes it to the governed ACP path end-to-end", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-promote-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir);
  // Stub `gemini` that, launched in ACP mode by the shim, IS our stub ACP agent.
  fs.writeFileSync(path.join(binDir, "gemini"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(acpAgent)}\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.BIVY_GEMINI_ACP = "1";
  // CLI probes are memoized for the process lifetime (invalidated on install); this
  // test swaps the binary on PATH, so re-probe as an install would.
  invalidateCliProbeCache();
  try {
    // Catalog honestly reflects the upgrade: approvals + resume on for gemini now.
    const info = listRuntimes().find((r) => r.id === "gemini")!;
    const caps = info.capabilities as Record<string, unknown>;
    assert.equal(caps.toolInterception, true, "promoted gemini advertises per-tool approvals");
    assert.equal(caps.resume, true, "promoted gemini advertises resume");

    const runtime = makeRuntime({ runtime: "gemini", credsDir: tmp, piDir: tmp, sessionsDir: tmp });
    assert.equal(runtime.capabilities.toolInterception, true, "the runtime instance is the governed ACP path, not the pipe");

    const decisions: unknown[] = [];
    const { session } = await runtime.createSession({ workspace: tmp, toolInterceptor: async (c) => { decisions.push(c); return undefined; } });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.prompt("hi gemini via acp");
    await waitFor(events, (e) => e.type === "agent_end");
    const text = events.filter((e) => e.type === "message_update").map((e) => (e as any).message?.content).filter((c: unknown) => typeof c === "string").join("");
    assert.match(text, /Hello from ACP/, "streamed via the ACP path");
    assert.equal(decisions.length, 1, "the tool permission was governed");
    session.dispose();
  } finally {
    delete process.env.BIVY_GEMINI_ACP;
    process.env.PATH = originalPath;
    invalidateCliProbeCache(); // restore real-PATH probes for later checks
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Every agent that ships a native ACP server declares `acp` as data, so promoting
// it (BIVY_<ID>_ACP=1) flips its advertised capabilities to the governed path
// (per-tool approvals + resume) with no per-agent runtime code. This locks the
// expected set and guards against a spec regression silently dropping an agent
// off — or onto — the ACP path. Capability advertisement is derived purely from
// the spec + env, so it needs no installed binary.
const ACP_CAPABLE = ["gemini", "qwen", "opencode", "goose", "kilocode", "cursor", "cline", "copilot"] as const;
// Agents promoted to ACP BY DEFAULT (spec.acp.preferred) — their default state
// depends on whether the installed binary evidences the ACP mode, so the opt-in
// assertion below doesn't apply to them.
const ACP_DEFAULT_ON = new Set(["opencode"]);
await check("acp: the expected agents declare an ACP mode and promote to governed caps", () => {
  for (const id of ACP_CAPABLE) {
    const envKey = `BIVY_${id.toUpperCase()}_ACP`;
    delete process.env[envKey];
    const before = listRuntimes().find((r) => r.id === id);
    assert.ok(before, `${id} must be in the picker`);
    if (!ACP_DEFAULT_ON.has(id)) {
      assert.equal((before!.capabilities as Record<string, unknown>).toolInterception, false, `${id} is on the pipe by default (honest capabilities)`);
    }
    process.env[envKey] = "1";
    try {
      const caps = listRuntimes().find((r) => r.id === id)!.capabilities as Record<string, unknown>;
      assert.equal(caps.toolInterception, true, `${id} promotes to per-tool approvals`);
      assert.equal(caps.resume, true, `${id} promotes to session/load resume`);
    } finally {
      delete process.env[envKey];
    }
  }
});

// The default-on promotion must stay reversible and must never be taken on faith.
// `BIVY_<ID>_ACP=0` is the operator escape hatch back to the pipe path, and the
// capabilities the picker shows have to follow it — otherwise the catalog would
// advertise approvals a downgraded session doesn't actually enforce.
await check("acp: a default-on agent can be forced back to the pipe with =0", () => {
  for (const id of ACP_DEFAULT_ON) {
    const envKey = `BIVY_${id.toUpperCase()}_ACP`;
    process.env[envKey] = "0";
    try {
      const info = listRuntimes().find((r) => r.id === id);
      assert.ok(info, `${id} must be in the picker`);
      const caps = info!.capabilities as Record<string, unknown>;
      assert.equal(caps.toolInterception, false, `${id} must drop per-tool approvals when forced onto the pipe`);
      assert.equal(info!.executionMode, "pipe", `${id} must actually run on the pipe when forced`);
    } finally {
      delete process.env[envKey];
    }
  }
});

// A default-on promotion is gated on the installed binary evidencing the ACP mode
// (a cached `--help` probe). Point the agent at a command whose help says nothing
// about ACP and it must degrade to the pipe rather than opening a dead session —
// the whole point of the gate, since ACP has no mid-session fallback.
await check("acp: default-on promotion degrades to the pipe when the binary has no ACP mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-acp-noacp-"));
  const originalPath = process.env.PATH;
  try {
    // A stand-in `opencode` whose --help mentions no `acp` subcommand.
    const fake = path.join(tmp, "opencode");
    fs.writeFileSync(fake, "#!/bin/sh\necho 'Usage: opencode run <message>'\n");
    fs.chmodSync(fake, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}${originalPath}`;
    delete process.env.BIVY_OPENCODE_ACP;
    // Re-probe the swapped-in fake binary (probes are cached for the process
    // lifetime and cleared on install; a PATH swap is the same situation).
    invalidateCliProbeCache();
    const info = listRuntimes().find((r) => r.id === "opencode")!;
    assert.equal((info.capabilities as Record<string, unknown>).toolInterception, false,
      "an opencode without an `acp` subcommand must not advertise per-tool approvals");
    assert.equal(info.executionMode, "pipe", "it must fall back to the honest pipe path");
  } finally {
    process.env.PATH = originalPath;
    invalidateCliProbeCache(); // restore real-PATH probes for later checks
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Agents with no first-party ACP server must NOT declare `acp`: setting the env
// flag is a no-op and they stay on the honest pipe (effect-level governance).
await check("acp: agents without a native ACP mode are not promotable", () => {
  for (const id of ["aider", "amp", "crush", "continue", "grok"]) {
    const envKey = `BIVY_${id.toUpperCase()}_ACP`;
    process.env[envKey] = "1";
    try {
      const info = listRuntimes().find((r) => r.id === id);
      if (!info) continue; // not in the picker on this build — nothing to assert
      assert.equal((info.capabilities as Record<string, unknown>).toolInterception, false, `${id} has no ACP mode, so it stays on the pipe even when the flag is set`);
    } finally {
      delete process.env[envKey];
    }
  }
});

if (failures > 0) {
  console.error(`\n${failures} acp-adapter test(s) failed`);
  process.exit(1);
}
console.log("\nacp-adapter: all tests passed");
