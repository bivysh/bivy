#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// ACP ⇄ Bivy Agent Protocol shim — the GENERAL high-capability adapter.
//
// The Codex shim (codex-app-server-shim.mjs) proved that driving an agent's
// bidirectional JSON-RPC app-server — instead of a one-shot stdout pipe — buys
// per-tool approvals, streaming, and resume. Everything there is Codex-specific is
// the *protocol*. ACP (Agent Client Protocol, https://agentclientprotocol.com) is
// the open standard for exactly that surface, and a growing set of agents speak it
// (Gemini CLI `--experimental-acp`, and others). This shim bridges ANY ACP agent to
// the bivy-agent-protocol JSONL that ProtocolRuntime (src/runtime/protocol.ts)
// speaks — so a new ACP agent becomes fully governed (Approve/Deny per tool),
// streaming, and resumable as DATA (one catalog entry), never per-agent code.
//
// Usage (spawned by the daemon's `acp` runtime):
//   node acp-shim.mjs --agent <cmd> [-- <agent args…>]
//
// ACP surface implemented (client side of the protocol):
//   → initialize / session/new / session/load / session/prompt / session/cancel
//   ← session/update  (agent_message_chunk, agent_thought_chunk, tool_call,
//                       tool_call_update, plan) → streamed transcript
//   ← session/request_permission → a bivy `tool.call` we block on until the human
//                       taps Approve/Deny (answered as the ACP selected option)
//   ← fs/read_text_file / fs/write_text_file → serviced against the workspace
//
// Transport is newline-delimited JSON-RPC 2.0 over the agent's stdio (as Gemini's
// ACP mode emits). Experimental: validate against your ACP agent, then promote it
// into the picker as data. Fail-closed on permission (deny if the human declines),
// fail-safe elsewhere (surface errors as session.error rather than wedging).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";

// --- arg parsing: --agent <cmd> [-- <args…>] --------------------------------
const argv = process.argv.slice(2);
let agentCmd = process.env.BIVY_ACP_COMMAND || "";
let agentArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--agent") agentCmd = argv[++i] ?? "";
  else if (argv[i] === "--") { agentArgs = argv.slice(i + 1); break; }
}
if (process.env.BIVY_ACP_ARGS && agentArgs.length === 0) {
  try { const p = JSON.parse(process.env.BIVY_ACP_ARGS); if (Array.isArray(p)) agentArgs = p.map(String); } catch { /* ignore */ }
}
if (!agentCmd) {
  process.stderr.write("acp-shim: no agent command (set --agent <cmd> or BIVY_ACP_COMMAND)\n");
  process.exit(2);
}

// MCP servers to advertise to the ACP agent on session/new and session/load.
// Bivy passes its configured servers as a JSON array of ACP mcpServer objects
// (see acpMcpServersFromConfig in src/runtime/index.ts). Forwarding them lets an
// ACP agent reach the user's MCP tools — previously hardcoded to [] so ACP
// agents were cut off from MCP entirely. Defaults to none; a malformed value is
// ignored rather than crashing the shim.
let mcpServers = [];
if (process.env.BIVY_ACP_MCP_SERVERS) {
  try {
    const parsed = JSON.parse(process.env.BIVY_ACP_MCP_SERVERS);
    if (Array.isArray(parsed)) mcpServers = parsed;
  } catch { /* malformed → none */ }
}

// --- bivy-agent-protocol output (our stdout) --------------------------------
function bivy(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// --- ACP agent (child JSON-RPC over its stdio) ------------------------------
const agent = spawn(agentCmd, agentArgs, { stdio: ["pipe", "pipe", "pipe"] });
agent.stderr.on("data", (d) => process.stderr.write(`[acp-agent] ${d}`));
let nextId = 1;
const pending = new Map(); // jsonrpc id -> {resolve, reject}
let agentDead = null; // set to an Error once the child is gone

/**
 * The child is gone (spawn failure or exit). Every in-flight request must be
 * rejected: without this, a CLI whose ACP mode doesn't exist leaves `initialize`
 * pending forever and the daemon waits out its whole session.create timeout instead
 * of surfacing the real reason. Fail fast, with the reason.
 */
function killPending(reason) {
  if (agentDead) return;
  agentDead = reason instanceof Error ? reason : new Error(String(reason));
  bivy({ type: "session.error", error: agentDead.message });
  for (const [id, p] of [...pending]) { pending.delete(id); p.reject(agentDead); }
}
agent.on("error", (e) => killPending(`acp agent spawn failed: ${e.message}`));
agent.on("exit", (code, signal) => {
  if (code || signal) killPending(`acp agent exited (${code ?? signal})`);
});
// Writing to a dead child's stdin raises EPIPE; with no listener that's an uncaught
// exception that takes the shim down mid-turn instead of reporting the cause.
agent.stdin.on("error", (e) => killPending(`acp agent stdin closed: ${e.message}`));

function agentWrite(payload) {
  if (agentDead) throw agentDead;
  agent.stdin.write(`${JSON.stringify(payload)}\n`);
}
function agentRequest(method, params, { timeoutMs } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer;
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    try { agentWrite({ jsonrpc: "2.0", id, method, params }); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}
function agentReply(id, result) {
  try { agentWrite({ jsonrpc: "2.0", id, result }); } catch { /* child gone; killPending already reported it */ }
}
function agentReplyError(id, code, message) {
  try { agentWrite({ jsonrpc: "2.0", id, error: { code, message } }); } catch { /* child gone */ }
}
function agentNotify(method, params) {
  try { agentWrite({ jsonrpc: "2.0", method, params }); } catch { /* child gone */ }
}

// --- session state ----------------------------------------------------------
let sessionId = null;
let cwd = process.cwd();
let initialized = false;
// The ACP config-option id that selects the model (usually "model"), learned from
// session/new; used for the session/set_config_option fallback.
let modelConfigId = "model";
// A model chosen before the ACP session existed, applied once it does.
let pendingModel = null;
// toolCallId -> { requestId, options } so a later bivy tool.decision answers the
// right ACP permission request with a concrete optionId.
const permissionRequests = new Map();

// --- trailing-update drain ---------------------------------------------------
// opencode's ACP server resolves `session/prompt` (the end_turn reply) BEFORE the
// final `agent_message_chunk` frames are flushed — a known upstream ordering race
// (opencode#17505). If the shim declared session.done the instant the prompt reply
// arrived, the turn would seal at ProtocolRuntime with the reply's tail still
// unstreamed: the trailing text then streams live (message_update) but never
// reaches getMessages(), so it vanishes the moment the session reopens. So the
// turn is NOT done at prompt-resolve — hold session.done until the session/update
// stream has been quiet for TRAILING_DRAIN_MS, letting the late chunks land while
// the turn is still open and get sealed into history.
const TRAILING_DRAIN_MS = 250;
let turnDrainTimer = null;
let turnDraining = false;
function scheduleTurnDone() {
  clearTimeout(turnDrainTimer);
  turnDrainTimer = setTimeout(finishTurnDone, TRAILING_DRAIN_MS);
}
function finishTurnDone() {
  turnDrainTimer = null;
  if (!turnDraining) return;
  turnDraining = false;
  bivy({ type: "session.status", status: "idle" });
  bivy({ type: "session.done" });
}

// --- tool-call field normalization -------------------------------------------
// ACP's `tool_call`/`tool_call_update` carries a free-text `title` (whatever
// prose the agent chose) AND a small fixed `kind` enum (read/edit/delete/move/
// search/execute/think/fetch/other) that matches the node's tool taxonomy
// (src/runtime/tool-call-map.ts) far better than prose does. It also often
// splits the substantive data across three places — `rawInput` (frequently
// empty on the *first* tool_call notification for some agents, opencode
// included), `locations` (paths the call touches), and `content` (diff/text
// blocks, usually only populated by a later tool_call_update) — so a naive
// single-notification read sees "no real information". Accumulate everything
// we've learned about a call across its whole lifecycle, keyed by toolCallId.
const toolCallState = new Map();

// The subset of ACP kinds that line up 1:1 with a bucket tool-call-map.ts
// already recognizes by name; kinds outside this set (delete/move/think/other)
// have no equivalent normalized rendering yet, so fall back to the agent's own
// title/kind for display rather than inventing a bucket for them.
const KIND_TOOL_NAME = { read: "read", edit: "edit", execute: "execute", search: "search", fetch: "fetch" };

function mergeToolCallState(toolCallId, u) {
  const prev = toolCallState.get(toolCallId) || {};
  // `content` is normally a ContentBlock[], but some agents send a single block
  // object (the existing `textOf` helper already tolerates both shapes) — wrap
  // it so downstream array-walkers (diffContentFields) see it either way.
  const content = u.content == null ? undefined : Array.isArray(u.content) ? u.content : [u.content];
  const next = {
    kind: u.kind ?? prev.kind,
    title: u.title ?? prev.title,
    rawInput: u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length ? u.rawInput : prev.rawInput,
    locations: Array.isArray(u.locations) && u.locations.length ? u.locations : prev.locations,
    content: content && content.length ? content : prev.content,
  };
  toolCallState.set(toolCallId, next);
  return next;
}

/** The ACP "diff" content block, if the call carries one — the shape opencode
 *  (and most ACP agents) use to report an edit's before/after text. */
function diffContentFields(content) {
  for (const c of content || []) {
    if (c && c.type === "diff") return { path: c.path, oldText: c.oldText, newText: c.newText };
  }
  return {};
}

/** Merge everything accumulated about a call into one `input` object shaped the
 *  way tool-call-map.ts's key scan expects (path/command/old_string/new_string/…),
 *  so a call whose `rawInput` was sparse still classifies once its diff/locations
 *  arrive. `rawInput` (the underlying tool's own arguments) wins on key conflicts
 *  since it's the most literal source. */
function toolCallInput(state) {
  const input = { ...(state.rawInput || {}) };
  const diff = diffContentFields(state.content);
  if (input.path == null && diff.path != null) input.path = diff.path;
  if (input.old_string == null && diff.oldText != null) input.old_string = diff.oldText;
  if (input.new_string == null && diff.newText != null) input.new_string = diff.newText;
  if (input.path == null && state.locations?.[0]?.path != null) input.path = state.locations[0].path;
  return input;
}

/** Prefer ACP's structured `kind` (maps straight onto the node's taxonomy) over
 *  the agent's free-text `title` — a title like "Edit `src/index.ts`" defeats
 *  both the node's bucket classifier and the client's own name-based heuristic,
 *  which both expect short tool-name-like tokens, not prose. */
function toolCallName(state) {
  return (state.kind && KIND_TOOL_NAME[state.kind]) || state.title || state.kind || "tool";
}

async function ensureInitialized() {
  if (initialized) return;
  // Bounded: a binary that accepts the launch args but never speaks ACP would
  // otherwise hang here until the daemon's own session timeout, hiding the cause.
  await agentRequest("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  }, { timeoutMs: 20_000 });
  initialized = true;
}

/**
 * ACP exposes a session's selectable models as a `select` config option on the
 * session/new|load result (opencode: `configOptions: [{id:"model", currentValue,
 * options:[{value,name}]}]`). Models are per-NODE — they depend on which providers
 * the user has authenticated in the agent — so a hardcoded list would offer models
 * the agent rejects. Publish what the agent actually reports, as a post-hello
 * `runtime.models` event ProtocolRuntime folds into its picker.
 */
function publishModels(result) {
  const options = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const modelOption = options.find((o) => String(o?.id ?? "") === "model" || String(o?.category ?? "") === "model");
  const choices = Array.isArray(modelOption?.options) ? modelOption.options : [];
  const models = choices
    .map((o) => ({ id: String(o?.value ?? ""), name: String(o?.name ?? o?.value ?? "") }))
    .filter((m) => m.id)
    // ACP model ids are `provider/model`; split the provider so Bivy can group and
    // scope provider-specific settings the same way it does for other runtimes.
    .map((m) => ({ ...m, provider: m.id.includes("/") ? m.id.split("/")[0] : "agent" }));
  if (!models.length) return;
  modelConfigId = String(modelOption?.id ?? "model");
  bivy({
    type: "runtime.models",
    models,
    ...(modelOption?.currentValue ? { currentModel: String(modelOption.currentValue) } : {}),
  });
}

// --- ACP → bivy: streamed session/update notifications ----------------------
function onSessionUpdate(params) {
  const u = params?.update;
  if (!u || typeof u !== "object") return;
  // Any update arriving while the turn is draining means the agent is still
  // emitting the tail of this turn (see the drain note above) — reset the quiet
  // window so session.done waits for it instead of sealing history short.
  if (turnDraining) scheduleTurnDone();
  const kind = String(u.sessionUpdate || "");
  const textOf = (content) => {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(textOf).join("");
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (typeof content.text === "string") return content.text;
    return "";
  };
  switch (kind) {
    case "agent_message_chunk": {
      const t = textOf(u.content);
      if (t) bivy({ type: "message.delta", text: t });
      break;
    }
    case "agent_thought_chunk": {
      const t = textOf(u.content);
      if (t) bivy({ type: "message.reasoning", text: t });
      break;
    }
    case "tool_call": {
      // An auto-run tool (no permission requested) — surface it so the transcript
      // shows the action; the result arrives via tool_call_update.
      const toolCallId = String(u.toolCallId ?? u.id ?? "");
      const state = mergeToolCallState(toolCallId, u);
      bivy({ type: "tool.call", toolCallId, name: toolCallName(state), input: toolCallInput(state) });
      break;
    }
    case "tool_call_update": {
      const toolCallId = String(u.toolCallId ?? u.id ?? "");
      const state = mergeToolCallState(toolCallId, u);
      const status = String(u.status || "");
      if (status === "completed" || status === "failed") {
        toolCallState.delete(toolCallId);
        bivy({
          type: "tool.result",
          toolCallId,
          name: toolCallName(state),
          result: textOf(u.content) || status,
          isError: status === "failed",
        });
      } else {
        // Still running: forward the fuller name/input as it fills in so a live
        // tool card isn't stuck with the sparse initial notification.
        bivy({ type: "tool.update", toolCallId, name: toolCallName(state), input: toolCallInput(state) });
      }
      break;
    }
    case "plan":
      // Optional planning stream — fold into reasoning so nothing is lost.
      if (Array.isArray(u.entries)) bivy({ type: "message.reasoning", text: u.entries.map((e) => `• ${e.content ?? ""}`).join("\n") });
      break;
    default:
      break;
  }
}

// --- ACP → bivy: agent→client requests (permission, fs) ---------------------
async function onAgentRequest(id, method, params) {
  switch (method) {
    case "session/request_permission": {
      // Turn the ACP permission prompt into a bivy tool.call the daemon gates via
      // guardianInterceptor; remember the options so the human's decision maps back
      // to a concrete ACP optionId.
      const tc = params?.toolCall ?? {};
      const toolCallId = String(tc.toolCallId ?? tc.id ?? `perm-${id}`);
      const options = Array.isArray(params?.options) ? params.options : [];
      permissionRequests.set(toolCallId, { requestId: id, options });
      const state = mergeToolCallState(toolCallId, tc);
      bivy({ type: "tool.call", toolCallId, name: toolCallName(state), input: toolCallInput(state) });
      return;
    }
    case "fs/read_text_file": {
      try {
        let text = fs.readFileSync(String(params?.path ?? ""), "utf8");
        if (typeof params?.line === "number" || typeof params?.limit === "number") {
          const lines = text.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          text = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n");
        }
        agentReply(id, { content: text });
      } catch (e) {
        agentReplyError(id, -32000, `read failed: ${e.message}`);
      }
      return;
    }
    case "fs/write_text_file": {
      try {
        fs.writeFileSync(String(params?.path ?? ""), String(params?.content ?? ""));
        agentReply(id, {});
      } catch (e) {
        agentReplyError(id, -32000, `write failed: ${e.message}`);
      }
      return;
    }
    default:
      // Unknown client method (e.g. terminal/*): decline so the agent can fall back
      // instead of hanging on a request we don't implement.
      agentReplyError(id, -32601, `unsupported client method: ${method}`);
      return;
  }
}

// --- read the ACP agent's stdout (JSON-RPC lines) ---------------------------
createInterface({ input: agent.stdout }).on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  // Response to one of our requests.
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "acp error"));
      else p.resolve(msg.result);
    }
    return;
  }
  // Agent→client request (has id + method).
  if (msg.id !== undefined && msg.method) { void onAgentRequest(msg.id, msg.method, msg.params); return; }
  // Notification (method, no id).
  if (msg.method === "session/update") onSessionUpdate(msg.params);
});

/**
 * Select a model on the live ACP session. `session/set_model` is the direct form;
 * agents that only expose the generic config-option surface take the same choice as
 * `session/set_config_option`. A rejection propagates: ProtocolRuntime only commits
 * the selection once we ack, so a model the agent won't accept must not look applied.
 */
async function setAgentModel(model) {
  try {
    await agentRequest("session/set_model", { sessionId, modelId: model }, { timeoutMs: 15_000 });
  } catch (primary) {
    try {
      await agentRequest("session/set_config_option", { sessionId, configId: modelConfigId, value: model }, { timeoutMs: 15_000 });
    } catch {
      throw primary;
    }
  }
}

async function applyPendingModel() {
  if (!pendingModel || !sessionId) return;
  const model = pendingModel;
  pendingModel = null;
  // Best-effort: a stale pick shouldn't block the session from opening.
  try { await setAgentModel(model); }
  catch (e) { bivy({ type: "runtime.debug", message: `acp set_model failed: ${e instanceof Error ? e.message : String(e)}` }); }
}

// --- bivy commands in (daemon → us) -----------------------------------------
async function onBivyCommand(msg) {
  const type = String(msg.type || "");
  const id = msg.id;
  try {
    switch (type) {
      case "hello.ack":
        return;
      case "session.create": {
        await ensureInitialized();
        cwd = String(msg.cwd || msg.workspace || cwd);
        const res = await agentRequest("session/new", { cwd, mcpServers });
        sessionId = res?.sessionId ?? res?.session?.id ?? null;
        publishModels(res);
        await applyPendingModel();
        bivy({ replyTo: id, ok: true, runtimeSessionRef: sessionId });
        return;
      }
      case "session.resume": {
        await ensureInitialized();
        const ref = String(msg.runtimeSessionRef || msg.resumeRef || msg.sessionId || "");
        cwd = String(msg.cwd || msg.workspace || cwd);
        if (!ref) { bivy({ replyTo: id, ok: false, error: "missing resume ref" }); return; }
        try {
          // Bounded: a wedged agent (opencode's ACP server can stop responding —
          // see the drain note) would otherwise leave session/load pending forever,
          // hanging the reopen with no watchdog to recover it (resume isn't a
          // "working" turn). On timeout/failure we fall back to a fresh session so
          // the chat still opens instead of spinning on "Fetching transcript…".
          const res = await agentRequest("session/load", { sessionId: ref, cwd, mcpServers }, { timeoutMs: 30_000 });
          sessionId = res?.sessionId ?? ref;
          publishModels(res);
        } catch {
          // Agent doesn't support session/load (or it timed out) — start fresh so
          // the chat still opens.
          const res = await agentRequest("session/new", { cwd, mcpServers });
          sessionId = res?.sessionId ?? null;
          publishModels(res);
        }
        await applyPendingModel();
        bivy({ replyTo: id, ok: true, runtimeSessionRef: sessionId });
        return;
      }
      case "chat.send": {
        if (!sessionId) { bivy({ replyTo: id, ok: false, error: "no acp session" }); return; }
        // Ack immediately; the turn streams via session/update and finishes when the
        // session/prompt request resolves (approval cards can make a turn outlast
        // ProtocolRuntime's command timeout, so we must not defer the ack).
        bivy({ replyTo: id, ok: true });
        bivy({ type: "session.status", status: "working" });
        agentRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: String(msg.text ?? "") }] })
          .then(() => {
            // The prompt reply is NOT the end of the turn for opencode — the last
            // agent_message_chunk frames trail it (see the drain note above). Arm
            // the drain; session.done fires once the update stream goes quiet.
            turnDraining = true;
            scheduleTurnDone();
          })
          .catch((e) => {
            clearTimeout(turnDrainTimer);
            turnDrainTimer = null;
            turnDraining = false;
            bivy({ type: "session.error", error: e instanceof Error ? e.message : String(e) });
          });
        return;
      }
      case "tool.decision": {
        const entry = permissionRequests.get(msg.toolCallId);
        if (entry) {
          permissionRequests.delete(msg.toolCallId);
          const allow = msg.decision !== "deny";
          // Pick an ACP option matching the human's choice by its `kind`
          // (allow_once/allow_always vs reject_once/reject_always); fall back to the
          // first option, or a cancelled outcome when nothing fits.
          const want = allow ? /^allow/ : /^reject/;
          const opt = entry.options.find((o) => want.test(String(o.kind || ""))) ?? entry.options[0];
          if (opt && opt.optionId !== undefined) agentReply(entry.requestId, { outcome: { outcome: "selected", optionId: opt.optionId } });
          else agentReply(entry.requestId, { outcome: { outcome: "cancelled" } });
        }
        return;
      }
      case "model.set": {
        const model = String(msg.model ?? "").trim();
        if (!model) { bivy({ replyTo: id, ok: true }); return; }
        if (!sessionId) {
          // Chosen before the session exists — remember and apply at session/new.
          pendingModel = model;
          bivy({ replyTo: id, ok: true });
          return;
        }
        await setAgentModel(model);
        bivy({ replyTo: id, ok: true });
        return;
      }
      case "session.abort": {
        // A pending drain must not fire session.done after the user cancelled —
        // the turn is being torn down, not finishing on its own.
        clearTimeout(turnDrainTimer);
        turnDrainTimer = null;
        turnDraining = false;
        if (sessionId) agentNotify("session/cancel", { sessionId });
        if (id !== undefined) bivy({ replyTo: id, ok: true });
        return;
      }
      default:
        if (id !== undefined) bivy({ replyTo: id, ok: true });
        return;
    }
  } catch (error) {
    if (id !== undefined) bivy({ replyTo: id, ok: false, error: error instanceof Error ? error.message : String(error) });
    else bivy({ type: "session.error", error: error instanceof Error ? error.message : String(error) });
  }
}

// Announce capabilities: ACP agents are governed (per-tool permission) and
// resumable (session/load). modelSelection starts FALSE and is upgraded later by a
// `runtime.models` event if the session reports selectable models — the list is
// per-node (it depends on the providers the user has authenticated in the agent)
// and only arrives with session/new, so claiming a picker here would be a guess.
bivy({ type: "hello", runtime: { capabilities: { toolInterception: true, modelSelection: false, resume: true } } });

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void onBivyCommand(msg);
});
