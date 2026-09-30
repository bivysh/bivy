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
import path from "node:path";

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
// True while session/load replays history (see session.resume).
let replayingHistory = false;
// The config-option id carrying reasoning effort (ACP category "thought_level"),
// when the agent advertises one.
let thoughtConfigId = null;
// toolCallId -> { requestId, options } so a later bivy tool.decision answers the
// right ACP permission request with a concrete optionId.
const permissionRequests = new Map();
// Calls the human (or policy) already approved. An agent that performs an
// approved edit through fs/write_text_file (Grok does) must not be gated — and
// carded — a second time for the same file.
const approvedCalls = new Set();

/** The still-running call among `ids` whose inputs name `file`, if any. */
function callWriting(file, ids) {
  for (const id of ids) {
    const state = toolCallState.get(id);
    if (!state) { if (ids === approvedCalls) approvedCalls.delete(id); continue; }
    const input = toolCallInput(state);
    const paths = [input.path, input.file_path, input.filePath, ...(state.locations || []).map((l) => l?.path)].filter(Boolean);
    const root = fs.realpathSync(cwd);
    if (paths.some((p) => path.resolve(root, String(p)) === file || path.resolve(cwd, String(p)) === file)) return id;
  }
  return undefined;
}
const sandboxTier = process.env.BIVY_ACP_SANDBOX || "workspace-write";

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve an ACP filesystem request inside the session workspace, including
 * symlink-safe checks for existing targets and the nearest existing parent. */
function workspacePath(requested, { write = false } = {}) {
  if (!requested) throw new Error("path is required");
  const root = fs.realpathSync(cwd);
  const candidate = path.resolve(root, String(requested));
  if (!isWithin(root, candidate)) throw new Error("path is outside the session workspace");
  if (!write || fs.existsSync(candidate)) {
    const resolved = fs.realpathSync(candidate);
    if (!isWithin(root, resolved)) throw new Error("path resolves outside the session workspace");
    return resolved;
  }
  let parent = path.dirname(candidate);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error("no existing parent for path");
    parent = next;
  }
  const resolvedParent = fs.realpathSync(parent);
  if (!isWithin(root, resolvedParent)) throw new Error("path parent resolves outside the session workspace");
  return candidate;
}

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
  ownCalls.clear();
  childParent.clear();
  approvedCalls.clear();
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
    // Agents open a call titled with the tool's own name ("task",
    // "spawn_subagent", "bash") and later retitle it with prose ("Count README
    // lines"). Keep the first identifier-like title as the stable name, so a
    // delegation still classifies as one after the retitle.
    name: prev.name ?? (typeof u.title === "string" && /^[A-Za-z_][\w.:-]*$/.test(u.title) ? u.title : undefined),
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
  return (state.kind && KIND_TOOL_NAME[state.kind]) || state.name || state.title || state.kind || "tool";
}

// --- sub-agent sessions ------------------------------------------------------
// Agents that run sub-agents as ACP sessions of their own (Grok's
// spawn_subagent) stream the child's updates over this same connection, tagged
// with the CHILD's sessionId. Folding those into the parent turn glued the
// sub-agent's prose onto the parent's answer and listed its tools as the
// parent's. Route them instead: child tool calls carry `parentToolCallId` (the
// delegating call, so the transcript nests them) and child prose stays out of
// the parent reply — the delegation's own tool result carries its answer.
const childParent = new Map(); // child sessionId -> delegating toolCallId ("" if unknown)
// This turn's own (non-child) calls, kept after they complete: a background
// sub-agent's spawn call often finishes before the child's first update lands.
const ownCalls = new Map(); // toolCallId -> accumulated state
const DELEGATION_NAME = /agent|task|delegat/i;

function isDelegation(state) {
  const input = state?.rawInput || {};
  return DELEGATION_NAME.test(String(state?.name || "")) || typeof input.subagent_type === "string" || typeof input.prompt === "string";
}

/** The delegating call for a child session: an explicit link when the agent
 *  sent one (see linkChildSession), else the newest delegation-shaped call of
 *  this turn that no other child has claimed, else the newest open call. */
function parentCallFor(childSessionId) {
  if (childParent.has(childSessionId)) return childParent.get(childSessionId);
  const claimed = new Set(childParent.values());
  const calls = [...ownCalls].reverse().filter(([id]) => !claimed.has(id));
  const pick = calls.find(([, st]) => isDelegation(st)) ?? calls.find(([id]) => toolCallState.has(id));
  const parent = pick?.[0] ?? "";
  childParent.set(childSessionId, parent);
  return parent;
}

/** An agent-specific notification that names a child session and its parent
 *  (`child_session_id` / `parent_session_id`, plus the tool call id or the
 *  delegation's description) pins the link instead of the heuristic above. */
function linkChildSession(update) {
  const child = update?.child_session_id ?? update?.childSessionId;
  const parentSession = update?.parent_session_id ?? update?.parentSessionId;
  if (!child || (parentSession && parentSession !== sessionId) || childParent.get(child)) return;
  const byId = update.tool_call_id ?? update.toolCallId;
  const match = byId && ownCalls.has(byId)
    ? byId
    : [...ownCalls].reverse().find(([, st]) => update.description && (st.title === update.description || st.rawInput?.description === update.description))?.[0];
  if (match) childParent.set(child, match);
}

/** Routing for an update from `sid`: null for this session, else the parent
 *  call id ("" when it can't be placed). */
function childRoute(sid) {
  if (!sid || !sessionId || sid === sessionId) return null;
  return parentCallFor(sid);
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
  // Reasoning effort rides the same config-option surface under ACP's
  // `thought_level` category (Grok: reasoning_effort xhigh/high/medium/low).
  const thoughtOption = options.find((o) => String(o?.category ?? "") === "thought_level");
  const levels = (Array.isArray(thoughtOption?.options) ? thoughtOption.options : []).map((o) => String(o?.value ?? "")).filter(Boolean);
  if (!models.length && !levels.length) return;
  if (models.length) modelConfigId = String(modelOption?.id ?? "model");
  if (levels.length) thoughtConfigId = String(thoughtOption.id);
  bivy({
    type: "runtime.models",
    models,
    ...(modelOption?.currentValue ? { currentModel: String(modelOption.currentValue) } : {}),
    ...(levels.length ? { thinking: { levels, ...(thoughtOption?.currentValue ? { current: String(thoughtOption.currentValue) } : {}) } } : {}),
  });
}

// --- ACP → bivy: streamed session/update notifications ----------------------
function onSessionUpdate(params) {
  const u = params?.update;
  if (!u || typeof u !== "object" || replayingHistory) return;
  // Any update arriving while the turn is draining means the agent is still
  // emitting the tail of this turn (see the drain note above) — reset the quiet
  // window so session.done waits for it instead of sealing history short.
  if (turnDraining) scheduleTurnDone();
  const kind = String(u.sessionUpdate || "");
  const parentCall = childRoute(params?.sessionId);
  const child = parentCall !== null;
  const nest = parentCall ? { parentToolCallId: parentCall } : {};
  const textOf = (content) => {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(textOf).join("");
    // ACP's ToolCallContent wraps a ContentBlock: `{ type: "content", content:
    // { type: "text", text } }`. Unwrap it (recursively) so a tool's real output
    // — a command's stdout, a fetched document, a read's text — isn't dropped,
    // which collapsed the tool_result to the bare status ("completed"). opencode
    // and most spec-compliant ACP agents deliver tool output in this wrapped
    // shape, so reading only the bare `{type:"text"}` form lost it in production.
    if (content.type === "content" && content.content != null) return textOf(content.content);
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (typeof content.text === "string") return content.text;
    return "";
  };
  switch (kind) {
    case "agent_message_chunk": {
      const t = textOf(u.content);
      if (t && !child) bivy({ type: "message.delta", text: t });
      break;
    }
    case "agent_thought_chunk": {
      const t = textOf(u.content);
      if (t && !child) bivy({ type: "message.reasoning", text: t });
      break;
    }
    case "tool_call": {
      // An auto-run tool (no permission requested) — surface it so the transcript
      // shows the action; the result arrives via tool_call_update.
      const toolCallId = String(u.toolCallId ?? u.id ?? "");
      const state = mergeToolCallState(toolCallId, u);
      if (!child) ownCalls.set(toolCallId, state);
      bivy({ type: "tool.observe", toolCallId, name: toolCallName(state), input: toolCallInput(state), ...nest });
      break;
    }
    case "tool_call_update": {
      const toolCallId = String(u.toolCallId ?? u.id ?? "");
      const state = mergeToolCallState(toolCallId, u);
      if (!child && ownCalls.has(toolCallId)) ownCalls.set(toolCallId, state);
      const status = String(u.status || "");
      if (status === "completed" || status === "failed") {
        toolCallState.delete(toolCallId);
        bivy({
          type: "tool.result",
          toolCallId,
          name: toolCallName(state),
          // Use the ACCUMULATED content (mergeToolCallState keeps the fullest
          // seen across the call's lifecycle), not just this terminal frame's.
          // Agents like opencode stream a command's stdout in an earlier
          // (in_progress) tool_call_update and leave `content` empty on the
          // closing frame — reading only `u.content` there collapsed the result
          // to the bare status ("completed"), dropping the real output. Prefer
          // the terminal frame's content when it has some, else the accumulated.
          result: textOf(u.content) || textOf(state.content) || status,
          isError: status === "failed",
          ...nest,
        });
      } else {
        // Still running: forward the fuller name/input as it fills in so a live
        // tool card isn't stuck with the sparse initial notification.
        bivy({ type: "tool.update", toolCallId, name: toolCallName(state), input: toolCallInput(state), ...nest });
      }
      break;
    }
    case "plan":
      // Optional planning stream — fold into reasoning so nothing is lost.
      if (!child && Array.isArray(u.entries)) bivy({ type: "message.reasoning", text: u.entries.map((e) => `• ${e.content ?? ""}`).join("\n") });
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
      const parentCall = childRoute(params?.sessionId);
      if (parentCall === null) ownCalls.set(toolCallId, state);
      bivy({ type: "tool.call", toolCallId, name: toolCallName(state), input: toolCallInput(state), ...(parentCall ? { parentToolCallId: parentCall } : {}) });
      return;
    }
    case "fs/read_text_file": {
      try {
        const file = workspacePath(params?.path);
        let text = fs.readFileSync(file, "utf8");
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
        if (sandboxTier === "read-only") throw new Error("writes are disabled by the read-only sandbox");
        const file = workspacePath(params?.path, { write: true });
        if (callWriting(file, approvedCalls)) {
          fs.writeFileSync(file, String(params?.content ?? ""));
          agentReply(id, {});
          return;
        }
        // An auto-run edit (no permission asked) performs its change through this
        // write. Gate the write under that call's own id, so the transcript keeps
        // one card for the edit instead of a second "Created" card for its effect.
        const owner = callWriting(file, toolCallState.keys());
        const ownerState = owner ? toolCallState.get(owner) : undefined;
        const toolCallId = owner ?? `acp-fs-write-${id}`;
        permissionRequests.set(toolCallId, { kind: "fs-write", requestId: id, file, content: String(params?.content ?? ""), ownCard: !owner });
        const parentCall = childRoute(params?.sessionId);
        bivy({ type: "tool.call", toolCallId, name: ownerState ? toolCallName(ownerState) : "write", input: ownerState ? toolCallInput(ownerState) : { path: file }, ...(parentCall ? { parentToolCallId: parentCall } : {}) });
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
  else if (msg.params?.update) linkChildSession(msg.params.update);
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
          // ACP agents replay the whole conversation as session/update during
          // session/load. Bivy already has that history; forwarding the replay
          // re-recorded past thinking (and could fold old text onto the last
          // reply) as if it were live.
          replayingHistory = true;
          let res;
          try { res = await agentRequest("session/load", { sessionId: ref, cwd, mcpServers }, { timeoutMs: 30_000 }); }
          finally { replayingHistory = false; }
          sessionId = res?.sessionId ?? ref;
          publishModels(res);
        } catch (error) {
          // Never disguise lost model context as a successful resume. The caller
          // can explicitly choose Bivy's disclosed seeded-continuation path.
          bivy({ replyTo: id, ok: false, error: `ACP session resume failed: ${error instanceof Error ? error.message : String(error)}` });
          return;
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
        const prompt = [];
        if (String(msg.text ?? "")) prompt.push({ type: "text", text: String(msg.text) });
        for (const image of Array.isArray(msg.images) ? msg.images : []) {
          if (image && typeof image.data === "string" && typeof image.mimeType === "string") prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        agentRequest("session/prompt", { sessionId, prompt })
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
          if (entry.kind === "fs-write") {
            // The write card is the shim's own call, so the shim closes it too —
            // left open it pinned the turn "Working" after the agent finished.
            let error = allow ? "" : String(msg.reason || "write denied by Bivy policy");
            if (allow) {
              try { fs.writeFileSync(entry.file, entry.content); }
              catch (e) { error = `write failed: ${e.message}`; }
            }
            if (error) agentReplyError(entry.requestId, allow ? -32000 : -32001, error);
            else agentReply(entry.requestId, {});
            // A write gated under the agent's own call leaves that card to the
            // agent's completion update.
            if (!entry.ownCard && allow) approvedCalls.add(msg.toolCallId);
            if (entry.ownCard) bivy({ type: "tool.result", toolCallId: msg.toolCallId, name: "write", result: error || `Wrote ${entry.file}`, isError: Boolean(error) });
            return;
          }
          // Pick an ACP option matching the human's choice by its `kind`
          // (allow_once/allow_always vs reject_once/reject_always); fall back to the
          // first option, or a cancelled outcome when nothing fits.
          if (allow) approvedCalls.add(msg.toolCallId);
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
      case "thinking.set": {
        const level = String(msg.level ?? "").trim();
        if (sessionId && thoughtConfigId && level) {
          try { await agentRequest("session/set_config_option", { sessionId, configId: thoughtConfigId, value: level }, { timeoutMs: 15_000 }); }
          catch (e) { bivy({ type: "runtime.debug", message: `acp set thought level failed: ${e instanceof Error ? e.message : String(e)}` }); }
        }
        if (id !== undefined) bivy({ replyTo: id, ok: true });
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
