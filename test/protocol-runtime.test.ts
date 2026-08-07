import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime, protocolCommandsFromEnv } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 3000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for protocol event")); }
    }, 10);
  });
}

const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol" });
const decisions: unknown[] = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async (ctx) => {
    decisions.push(ctx);
    return undefined;
  },
});

assert.equal(runtime.capabilities.toolInterception, true);
assert.equal(runtime.capabilities.resume, false);

// Agent-native slash commands advertised in the hello are parsed onto the
// runtime capabilities (validated: the malformed "not-a-command" entry, which
// lacks a leading slash, is dropped) so the composer can offer them. A
// protocol-mode command carries its `mode` through so the client routes it via
// command.invoke instead of a slash prompt.
assert.deepEqual(runtime.capabilities.commands, [
  { name: "/compact", description: "Compact the conversation." },
  { name: "/status", description: "Show agent status." },
  { name: "/deploy", description: "Deploy via the shim.", mode: "protocol" },
]);

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
await session.prompt("say hello");
await waitFor(events, (event) => event.type === "agent_end");

assert.equal(decisions.length, 1);
assert.equal((decisions[0] as { toolName: string }).toolName, "shell");

// History keeps the whole turn: the user prompt, an assistant message whose
// content blocks interleave the reply text with the tool_use in the order they
// actually streamed (the fixture sends "hello " before the tool call and
// "world" after it resolves — collapsing those into one merged text block
// ahead of every tool is exactly the "interim messages disappear/bundle at the
// end" bug this preserves against), and a trailing user message carrying the
// tool_result — so re-opening the session shows what the agent did, not just
// its final sentence.
const history = session.getMessages() as Array<{ role?: string; content?: unknown }>;
assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user"]);

const assistantBlocks = history[1].content as Array<Record<string, unknown>>;
assert.ok(Array.isArray(assistantBlocks));
assert.deepEqual(
  assistantBlocks.map((b) => b.type),
  ["text", "tool_use", "text"],
  "text and tool_use blocks interleave in streamed order, not text-then-all-tools",
);
assert.equal(assistantBlocks[0]?.text, "hello ");
assert.equal(assistantBlocks[2]?.text, "world");
const toolUse = assistantBlocks.find((b) => b.type === "tool_use");
assert.equal(toolUse?.name, "shell");
assert.equal(toolUse?.id, "tc_fixture");

const resultBlocks = history[2].content as Array<Record<string, unknown>>;
assert.equal(resultBlocks[0]?.type, "tool_result");
assert.equal(resultBlocks[0]?.tool_use_id, "tc_fixture");

assert.ok(events.some((event) => event.type === "tool_result"));
assert.equal(
  (events.find((event) => event.type === "tool_result") as { result?: unknown } | undefined)?.result,
  "allow",
  "protocol tool_result emits the displayable result text",
);

// --- Model selection over the protocol -------------------------------------
// The shim advertised a model registry in its hello, so the host derives a real
// picker even though capabilities.modelSelection was false in the hello — and the
// malformed no-id entry is dropped.
assert.equal(runtime.capabilities.modelSelection, true, "modelSelection derived from advertised models");
assert.deepEqual(session.getModels().map((m) => m.id), ["fixture-small", "fixture-large"]);
assert.equal(session.getCurrentModel()?.id, "fixture-small", "hello currentModel is the selection");
// setModel forwards a model.set the shim acknowledges, then commits the choice.
await session.setModel("fixture", "fixture-large");
assert.equal(session.getCurrentModel()?.id, "fixture-large", "setModel round-trips via model.set");

// --- Usage + reasoning over the protocol -----------------------------------
// The shim reported token usage during the turn; getUsage surfaces it.
assert.deepEqual((await session.getUsage())?.tokens, { input: 11, output: 7, total: 18 });
// Reasoning arrived as a thinking block, kept out of the answer text ("hello world").
assert.ok(
  events.some((e) => e.type === "message_update" && Array.isArray((e as { message?: { content?: unknown } }).message?.content) && ((e as { message: { content: Array<{ type?: string }> } }).message.content[0]?.type === "thinking")),
  "reasoning surfaced as a thinking block",
);

// The dumb-pipe runtime has no model to name a session with. suggestName() must
// return undefined (not a raw truncation of the first message) so it doesn't
// override the deterministic title/branch, and so the node-level LLM namer can
// refine it. Regression: it used to return firstPrompt.slice(0, 60), which
// clobbered the clean title with a raw first-message dump for every CLI agent.
assert.equal(await session.suggestName("Build me a whole new onboarding flow with SSO and audit logs"), undefined);

// --- Protocol-mode command invocation --------------------------------------
// A protocol-mode command (advertised with mode: "protocol") is invoked via
// RuntimeSession.invokeCommand → a dedicated command.invoke message, NOT a slash
// prompt. The fixture echoes back a `command.invoked` event carrying the name +
// args so we can prove the raw args reached the shim over the command channel.
await session.invokeCommand("/deploy", "staging --force");
const invoked = await waitFor(events, (event) => event.type === "command.invoked");
assert.equal((invoked as { name?: string }).name, "/deploy", "protocol command routed via command.invoke");
assert.equal((invoked as { args?: string }).args, "staging --force", "command args forwarded verbatim");

session.dispose();

// --- Late assistant delta after session.done (the ACP end_turn race) ---------
// opencode's session/prompt reply resolves before its final agent_message_chunk
// frames are flushed, so a chunk can land AFTER the turn was sealed. The host must
// fold it onto the already-persisted assistant message (and re-emit message_end so
// the daemon re-snapshots the base) rather than opening a fresh draft that never
// reaches getMessages() — otherwise the tail streams live but vanishes on reopen.
const lateDeltaRuntime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (late delta)",
  env: { FIXTURE_LATE_DELTA: "1" },
});
const { session: lateSession } = await lateDeltaRuntime.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
const lateEvents: RuntimeEvent[] = [];
lateSession.subscribe((event) => lateEvents.push(event));
await lateSession.prompt("say hello");
await waitFor(lateEvents, (event) => event.type === "agent_end");
// The 20ms-late chunk arrives after agent_end; the fold re-streams it and re-seals
// the message so the daemon's message_end re-snapshots the base transcript.
await waitFor(
  lateEvents,
  (event) =>
    event.type === "message_update" &&
    JSON.stringify((event as { message?: { content?: unknown } }).message?.content ?? "").includes("late tail"),
);
const lateAssistant = lateSession.getMessages().find((m) => (m as { role?: string }).role === "assistant") as
  | { content?: Array<{ type?: string; text?: string }> }
  | undefined;
const lateText = (lateAssistant?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
assert.equal(lateText, "hello world late tail", "the late delta is folded into the sealed assistant message, not lost");
assert.equal(
  lateEvents.filter((e) => e.type === "message_end").length,
  2,
  "the fold re-emits message_end so the daemon re-persists the corrected transcript",
);
lateSession.dispose();

// A concrete protocol adapter can delegate naming to its own authenticated
// agent. Codex uses this seam to run an ephemeral title-only Codex turn.
let namingContext: { cwd: string; model?: string } | undefined;
const namingRuntime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  suggestName: async (_prompt, context) => { namingContext = context; return "Agent Written Title"; },
});
const { session: namingSession } = await namingRuntime.createSession({ workspace: process.cwd() });
assert.equal(await namingSession.suggestName("A long first line that should not become the title"), "Agent Written Title");
assert.equal(namingContext?.model, "fixture-small");
namingSession.dispose();

// --- Multimodal image + steering passthrough -------------------------------
// The daemon hands prompt image attachments and a streaming hint to
// session.prompt() (the same PromptOptions native Claude receives). The protocol
// must forward them in chat.send instead of dropping them on the floor; the
// fixture echoes back what actually arrived as a `prompt.received` event.
const { session: imgSession } = await runtime.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
const imgEvents: RuntimeEvent[] = [];
imgSession.subscribe((event) => imgEvents.push(event));
await imgSession.prompt("look at this", {
  images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
  streamingBehavior: "steer",
});
const received = await waitFor(imgEvents, (event) => event.type === "prompt.received");
assert.equal((received as { images?: number }).images, 1, "image attachment forwarded to the protocol agent");
assert.equal((received as { streamingBehavior?: string }).streamingBehavior, "steer", "streaming hint forwarded");
imgSession.dispose();

// --- Resume path -----------------------------------------------------------
// A `resumable` runtime advertises resume up front, preloads history from the
// persisted ref, and passes that ref back to the shim so it reconnects the
// agent's own session instead of starting fresh.
const loadHistoryCalls: string[] = [];
const resumable = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (resumable)",
  resumable: true,
  loadHistory: (ref) => {
    loadHistoryCalls.push(ref);
    return [{ role: "user", content: `prior turn for ${ref}`, timestamp: 0 }];
  },
});

// Resume is advertised before any handshake (the plumbing is Bivy-side).
assert.equal(resumable.capabilities.resume, true);
// readMessages() hydrates a resumed transcript without a live child.
assert.deepEqual(
  (resumable.readMessages("thread-xyz") as Array<{ content?: unknown }>).map((m) => m.content),
  ["prior turn for thread-xyz"],
);
loadHistoryCalls.length = 0; // reset; count only the openSession preload below

const { session: resumed } = await resumable.openSession({
  workspace: process.cwd(),
  sessionFile: "thread-xyz",
  toolInterceptor: async () => undefined,
});
// History preloaded from the ref, and the ref round-trips via sessionFile.
assert.deepEqual(loadHistoryCalls, ["thread-xyz"]);
assert.equal((resumed.getMessages()[0] as { content?: unknown }).content, "prior turn for thread-xyz");
assert.equal(resumed.sessionFile, "thread-xyz");

const resumedEvents: RuntimeEvent[] = [];
resumed.subscribe((event) => resumedEvents.push(event));
await resumed.prompt("continue");
// The shim received the resume ref via session.resume and reconnected the thread.
const resumedEvent = await waitFor(resumedEvents, (event) => event.type === "session.resumed");
assert.equal((resumedEvent as { runtimeSessionRef?: string }).runtimeSessionRef, "thread-xyz");
await waitFor(resumedEvents, (event) => event.type === "agent_end");
resumed.dispose();

// --- Self-advertised resume ------------------------------------------------
// A protocol agent can enable resume purely by advertising `resume: true` in its
// hello — with NO Bivy-side `resumable` option. The host must honor that: once
// the handshake has flipped capabilities.resume on, openSession reconnects the
// agent's own thread (the ref round-trips through session.resume) instead of
// silently starting fresh. This closes the honesty gap where capabilities.resume
// could read true while resume did nothing.
const selfResume = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (self-advertised resume)",
  env: { FIXTURE_RESUME: "1" },
});
// No `resumable` option was set, so before any handshake resume is still off.
assert.equal(selfResume.capabilities.resume, false, "resume not advertised until the hello lands");
const { session: sr1 } = await selfResume.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
// The hello alone turned resume on.
assert.equal(selfResume.capabilities.resume, true, "hello-advertised resume is honored");
sr1.dispose();

const { session: sr2 } = await selfResume.openSession({
  workspace: process.cwd(),
  sessionFile: "thread-self",
  toolInterceptor: async () => undefined,
});
// The ref was carried into the reopened session (not discarded for a fresh one).
assert.equal(sr2.sessionFile, "thread-self", "resume ref carried into the reopened session");
const srEvents: RuntimeEvent[] = [];
sr2.subscribe((event) => srEvents.push(event));
await sr2.prompt("continue");
const resumedSelf = await waitFor(srEvents, (event) => event.type === "session.resumed");
assert.equal(
  (resumedSelf as { runtimeSessionRef?: string }).runtimeSessionRef,
  "thread-self",
  "shim reconnected the advertised thread instead of starting fresh",
);
await waitFor(srEvents, (event) => event.type === "agent_end");
sr2.dispose();

// --- Seeded commands -------------------------------------------------------
// A shim can advertise its slash commands up front via
// ProtocolRuntimeOptions.capabilities, so the composer offers them before the
// first session's hello. The seed is visible immediately and, crucially, a
// later hello that omits `commands` must not wipe it.
const seed = [{ name: "/seeded", description: "Seeded up front." }];
const seededRuntime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (seeded)",
  env: { FIXTURE_NO_COMMANDS: "1" },
  capabilities: { commands: seed },
});
// Advertised before any session/handshake.
assert.deepEqual(seededRuntime.capabilities.commands, seed);
const { session: seededSession } = await seededRuntime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async () => undefined,
});
// The hello (FIXTURE_NO_COMMANDS) carries no `commands`, so the seed survives.
assert.deepEqual(seededRuntime.capabilities.commands, seed);
seededSession.dispose();

// --- No models advertised → honest off -------------------------------------
// A shim whose hello omits models must leave modelSelection off and make setModel
// throw rather than pretend (the honesty invariant).
const noModels = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (no models)",
  env: { FIXTURE_NO_MODELS: "1" },
});
const { session: noModelSession } = await noModels.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
assert.equal(noModels.capabilities.modelSelection, false, "no models advertised → modelSelection off");
assert.deepEqual(noModelSession.getModels(), []);
await assert.rejects(() => noModelSession.setModel("", "x"), /not supported/, "setModel throws when no models");
noModelSession.dispose();

// protocolCommandsFromEnv parses/validates BIVY_PROTOCOL_COMMANDS (dropping the
// entry with no leading slash), carries a valid `mode`, and drops an unknown mode
// (falling back to prompt invocation). Returns undefined when unset or malformed.
process.env.BIVY_PROTOCOL_COMMANDS = JSON.stringify([
  { name: "/x", description: "X" },
  { name: "bad" },
  { name: "/deploy", description: "D", mode: "protocol" },
  { name: "/junk", mode: "nonsense" },
]);
assert.deepEqual(protocolCommandsFromEnv(), [
  { name: "/x", description: "X" },
  { name: "/deploy", description: "D", mode: "protocol" },
  { name: "/junk" },
]);
process.env.BIVY_PROTOCOL_COMMANDS = "not json";
assert.equal(protocolCommandsFromEnv(), undefined);
delete process.env.BIVY_PROTOCOL_COMMANDS;
assert.equal(protocolCommandsFromEnv(), undefined);

// --- No resume advertised → honest error ----------------------------------
const noResumeRuntime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "No Resume" });
await assert.rejects(
  () => noResumeRuntime.openSession({ workspace: process.cwd(), sessionFile: "resume-123" }),
  /does not support resume/,
);

// --- writeHistory wires a true cross-runtime replay fork INTO this agent ----
// Without the hook, forkHistoryImport is off and importHistoryForFork refuses;
// with it (Codex wires writeCodexRollout), the capability flips on and the
// method delegates — the seam the fork engine gates its "replayed" tier on.
const noHistoryImport = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "No History" });
assert.notEqual(noHistoryImport.capabilities.forkHistoryImport, true, "no writeHistory => capability off");
await assert.rejects(
  () => noHistoryImport.importHistoryForFork([{ role: "user", text: "hi" }], { workspace: process.cwd(), cwd: process.cwd() }),
  /does not support history import/,
);

let seen: unknown;
const historyImport = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "History Import",
  writeHistory: (history, ctx) => { seen = { history, ctx }; return { sessionFile: "roll-1", id: "roll-1" }; },
});
assert.equal(historyImport.capabilities.forkHistoryImport, true, "writeHistory => capability on");
const imported = await historyImport.importHistoryForFork(
  [{ role: "user", text: "port to rust" }, { role: "assistant", text: "on it" }],
  { workspace: "/w", cwd: "/w/fork", model: { provider: "provider", id: "model" } },
);
assert.deepEqual(imported, { sessionFile: "roll-1", id: "roll-1" }, "delegates to writeHistory's result");
assert.deepEqual((seen as { history: unknown }).history, [{ role: "user", text: "port to rust" }, { role: "assistant", text: "on it" }]);
assert.deepEqual((seen as { ctx: unknown }).ctx, {
  workspace: "/w",
  cwd: "/w/fork",
  model: { provider: "provider", id: "model" },
}, "the generic protocol seam forwards destination context without agent-specific branching");

// --- Credential preflight ---------------------------------------------------
// A runtime whose preflight reports no usable credential must surface an
// actionable session.error and end the turn WITHOUT forwarding the prompt to the
// agent (mirroring ProcessRuntime), so the daemon can raise the sign-in sheet
// instead of letting the shim's first upstream call 401.
const preflightRuntime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (preflight)",
  preflight: () => "no usable credential",
});
const { session: pfSession } = await preflightRuntime.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
const pfEvents: RuntimeEvent[] = [];
pfSession.subscribe((event) => pfEvents.push(event));
await pfSession.prompt("do the thing");
const pfError = await waitFor(pfEvents, (event) => event.type === "session.error");
assert.equal((pfError as { error?: string }).error, "no usable credential", "preflight message surfaced as session.error");
await waitFor(pfEvents, (event) => event.type === "agent_end");
assert.equal(pfSession.isStreaming, false, "streaming cleared after a preflight block");
// The prompt never reached the shim: no chat.send → no prompt.received echo.
assert.ok(!pfEvents.some((event) => event.type === "prompt.received"), "prompt not forwarded when preflight blocks");
pfSession.dispose();

// A preflight that returns undefined lets the turn proceed normally.
const okPreflightRuntime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  displayName: "Fixture Protocol (preflight ok)",
  preflight: () => undefined,
});
const { session: okSession } = await okPreflightRuntime.createSession({ workspace: process.cwd(), toolInterceptor: async () => undefined });
const okEvents: RuntimeEvent[] = [];
okSession.subscribe((event) => okEvents.push(event));
await okSession.prompt("say hello");
await waitFor(okEvents, (event) => event.type === "prompt.received");
await waitFor(okEvents, (event) => event.type === "agent_end");
assert.ok(!okEvents.some((event) => event.type === "session.error"), "no error when the credential preflight passes");
okSession.dispose();

console.log("protocol-runtime: all tests passed");
