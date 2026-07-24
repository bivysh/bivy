#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Codex ⇄ Bivy Agent Protocol shim (Tier 2 — in-chat approvals).
//
// Bivy's Tier-1 Codex runtime drives `codex exec --json`, which has no channel to
// gate a tool *before* it runs (stdin is the prompt; there is no approval event to
// answer). So Codex governance there is effect-level only (the exec jail).
//
// This shim gives Codex the same per-tool Approve/Deny cards as Claude/Pi by
// driving Codex's experimental `app-server` (stdio JSON-RPC) and translating it to
// the bivy-agent-protocol JSONL that `ProtocolRuntime` (src/runtime/protocol.ts)
// speaks. The app-server raises a server→client `requestApproval` before running a
// shell command or applying a patch; we surface that as a protocol `tool.call`,
// block on Bivy's `tool.decision`, and answer the app-server accept/decline. With
// `approvalPolicy: "untrusted"` Codex escalates every model-proposed action, so
// Bivy's guardianInterceptor sees — and can veto — each one.
//
// Protocol surfaces (verified against codex-cli 0.144.1):
//   • initialize                              → handshake
//   • thread/start {cwd, approvalPolicy, sandbox}  → threadId
//   • thread/resume {threadId, cwd, approvalPolicy, sandbox} → threadId
//   • turn/start {threadId, input:[{type:"text",text}]}
//   • item/agentMessage/delta {delta}         → assistant text
//   • item/commandExecution/requestApproval   → shell approval  ({decision:accept|decline})
//   • item/fileChange/requestApproval         → patch approval
//   • turn/completed                          → turn done
//
// This is a first-class v1: governed sessions with shell/patch approvals and a
// generic protocol `session.resume` primitive (thread/resume — validated against
// codex-cli 0.144.1). MCP-tool routing is still a follow-up.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CODEX_BIN = process.env.BIVY_CODEX_BIN || "codex";
// Force Codex to ask before every model-proposed action so Bivy governs each one.
const APPROVAL_POLICY = process.env.BIVY_CODEX_APPROVAL_POLICY || "untrusted";
const SANDBOX_MODE = process.env.BIVY_CODEX_SANDBOX || "workspace-write";

// --- bivy-agent-protocol output (our stdout) --------------------------------
function bivy(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// --- codex app-server (child JSON-RPC over its stdio) -----------------------
const as = spawn(CODEX_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let asNextId = 1;
const asPending = new Map(); // jsonrpc id -> {resolve, reject}
// itemId -> app-server request id, so a later tool.decision can answer the right approval.
const approvalRequests = new Map();

function asRequest(method, params) {
  const id = asNextId++;
  as.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => asPending.set(id, { resolve, reject }));
}
function asReply(id, result) {
  as.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

// --- session state ----------------------------------------------------------
let threadId = null;
let initialized = false;
let sawError = null;
let models = [];
let selectedModel = null;
const itemInputs = new Map();
const itemOutputs = new Map();
const agentMessageItems = new Set();
const reasoningItems = new Set();

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return text(value.text ?? value.content ?? value.summary ?? value.message ?? "");
  return String(value);
}

function commandText(command) {
  return Array.isArray(command) ? command.join(" ") : text(command);
}

function paramsItemId(params, fallback) {
  return String(params?.itemId || params?.callId || params?.item?.id || fallback || "");
}

function rememberItem(item) {
  if (!item || typeof item !== "object") return;
  const id = String(item.id || "");
  if (!id) return;
  if (item.type === "commandExecution") {
    itemInputs.set(id, {
      command: commandText(item.command),
      cwd: item.cwd,
      ...(item.source ? { source: item.source } : {}),
    });
    if (item.aggregatedOutput) itemOutputs.set(id, String(item.aggregatedOutput).slice(-4000));
  } else if (item.type === "fileChange") {
    itemInputs.set(id, { changes: item.changes ?? [], status: item.status });
  } else if (item.type === "mcpToolCall") {
    itemInputs.set(id, { server: item.server, tool: item.tool, arguments: item.arguments });
  }
}

function updateInput(itemId, patch = {}) {
  return { ...(itemInputs.get(itemId) || {}), ...patch };
}

function appendOutput(itemId, delta) {
  const output = `${itemOutputs.get(itemId) || ""}${text(delta)}`.slice(-4000);
  itemOutputs.set(itemId, output);
  return output;
}

function emitToolUpdate(itemId, name, input) {
  if (!itemId) return;
  bivy({ type: "tool_execution_update", toolCallId: itemId, toolName: name, input });
}

function emitReasoning(itemId, delta) {
  const body = text(delta);
  if (!body) return;
  if (itemId) reasoningItems.add(itemId);
  bivy({ type: "message.reasoning", text: body });
}

function reasoningFromItem(item) {
  return text(item?.summary).trim() || text(item?.content).trim();
}

function handleCompletedItem(params) {
  const item = params?.item;
  rememberItem(item);
  const itemId = paramsItemId(params);
  if (!item || typeof item !== "object" || !itemId) return;
  switch (item.type) {
    case "agentMessage":
      if (!agentMessageItems.has(itemId) && item.text) {
        agentMessageItems.add(itemId);
        bivy({ type: "message.delta", text: String(item.text) });
      }
      return;
    case "plan":
      if (!reasoningItems.has(itemId) && item.text) emitReasoning(itemId, item.text);
      return;
    case "reasoning": {
      const body = reasoningFromItem(item);
      if (!reasoningItems.has(itemId) && body) emitReasoning(itemId, body);
      return;
    }
    case "commandExecution": {
      const output = text(item.aggregatedOutput ?? itemOutputs.get(itemId));
      if (output) itemOutputs.set(itemId, output.slice(-4000));
      emitToolUpdate(itemId, "shell", updateInput(itemId, { output }));
      bivy({ type: "tool.result", toolCallId: itemId, name: "shell", result: output || text(item.status || "completed") });
      return;
    }
    case "fileChange": {
      const status = text(item.status || "completed");
      itemInputs.set(itemId, updateInput(itemId, { changes: item.changes ?? [], status }));
      emitToolUpdate(itemId, "apply_patch", updateInput(itemId));
      bivy({ type: "tool.result", toolCallId: itemId, name: "apply_patch", result: status });
      return;
    }
    case "mcpToolCall": {
      const name = text(item.tool || "mcp");
      const result = text(item.result ?? item.error ?? "");
      bivy({ type: "tool.result", toolCallId: itemId, name, result });
      return;
    }
    default:
      return;
  }
}

as.stderr.on("data", (d) => {
  const s = d.toString();
  // Bubblewrap-missing is a benign warning; surface anything else for debugging.
  if (!/bubblewrap|configWarning/.test(s)) process.stderr.write(`[codex-app-server] ${s}`);
});
as.on("close", (code) => {
  bivy({ type: "session.error", error: `codex app-server exited (${code})` });
  process.exit(code ?? 1);
});

// Parse the app-server's newline-delimited JSON-RPC.
createInterface({ input: as.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  // Response to one of our requests.
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && !m.method) {
    const p = asPending.get(m.id);
    if (p) {
      asPending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "app-server error"));
      else p.resolve(m.result);
    }
    return;
  }
  // Server→client request (needs a reply).
  if (m.id !== undefined && m.method) return onServerRequest(m);
  // Notification (event).
  if (m.method) return onNotification(m);
});

function onServerRequest(m) {
  const { method, id, params } = m;
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const itemId = paramsItemId(params, id);
    approvalRequests.set(itemId, id);
    const input = {
      command: commandText(params.command),
      cwd: params.cwd,
      reason: params.reason,
      ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    };
    itemInputs.set(itemId, input);
    bivy({ type: "tool.call", toolCallId: itemId, name: "shell", input });
    return;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const itemId = paramsItemId(params, id);
    approvalRequests.set(itemId, id);
    const input = {
      reason: params.reason,
      changes: params.changes ?? params.fileChanges,
      ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
    };
    itemInputs.set(itemId, input);
    bivy({ type: "tool.call", toolCallId: itemId, name: "apply_patch", input });
    return;
  }
  // Any other server→client request we don't model yet: accept so the turn isn't
  // wedged (these are non-tool prompts like auth-token refresh). Decline would
  // abort the turn; the exec jail still bounds real effects.
  asReply(id, {});
}

function onNotification(m) {
  const { method, params } = m;
  switch (method) {
    case "item/agentMessage/delta":
      if (typeof params.delta === "string" && params.delta) {
        const itemId = paramsItemId(params);
        if (itemId) agentMessageItems.add(itemId);
        bivy({ type: "message.delta", text: params.delta });
      }
      return;
    case "item/plan/delta":
      emitReasoning(paramsItemId(params), params.delta);
      return;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      emitReasoning(paramsItemId(params), params.delta);
      return;
    case "item/commandExecution/outputDelta": {
      const itemId = paramsItemId(params);
      const output = appendOutput(itemId, params.delta);
      emitToolUpdate(itemId, "shell", updateInput(itemId, { output }));
      return;
    }
    case "item/fileChange/outputDelta": {
      const itemId = paramsItemId(params);
      const output = appendOutput(itemId, params.delta);
      emitToolUpdate(itemId, "apply_patch", updateInput(itemId, { output }));
      return;
    }
    case "item/fileChange/patchUpdated": {
      const itemId = paramsItemId(params);
      itemInputs.set(itemId, updateInput(itemId, { changes: params.changes ?? [] }));
      emitToolUpdate(itemId, "apply_patch", updateInput(itemId));
      return;
    }
    case "item/started": {
      const item = params?.item;
      rememberItem(item);
      const itemId = paramsItemId(params);
      if (item?.type === "commandExecution") emitToolUpdate(itemId, "shell", updateInput(itemId));
      if (item?.type === "fileChange") emitToolUpdate(itemId, "apply_patch", updateInput(itemId));
      return;
    }
    case "item/completed":
      handleCompletedItem(params);
      return;
    case "thread/tokenUsage/updated":
      if (params?.tokenUsage) bivy({ type: "usage", usage: params.tokenUsage.last ?? params.tokenUsage.total ?? params.tokenUsage });
      return;
    case "rawResponse/completed":
      if (params?.usage) bivy({ type: "usage", usage: params.usage });
      return;
    case "turn/started":
      bivy({ type: "session.status", status: "working" });
      return;
    case "turn/completed": {
      bivy({ type: "session.status", status: "idle" });
      if (sawError) { bivy({ type: "session.error", error: sawError }); sawError = null; }
      else bivy({ type: "session.done" });
      return;
    }
    case "turn/failed":
    case "error":
      sawError = params?.error?.message || params?.message || "Codex turn failed";
      return;
    default:
      return;
  }
}

// --- bivy-agent-protocol input (our stdin) ----------------------------------
async function ensureInitialized() {
  if (initialized) return;
  await asRequest("initialize", { clientInfo: { name: "bivy", title: "Bivy", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  initialized = true;
}

function threadParams(msg, extra = {}) {
  return {
    cwd: msg.workspace || process.cwd(),
    approvalPolicy: APPROVAL_POLICY,
    sandbox: SANDBOX_MODE,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...extra,
  };
}

async function onBivyCommand(msg) {
  const type = String(msg.type || "");
  const id = msg.id;
  try {
    switch (type) {
      case "hello.ack":
        return;
      case "session.create": {
        await ensureInitialized();
        // Back-compat for older ProtocolRuntime builds that carried resume as a
        // field on session.create. New hosts use the explicit session.resume
        // primitive below.
        if (typeof msg.resume === "string" && msg.resume) {
          const resumed = await asRequest("thread/resume", threadParams(msg, { threadId: msg.resume }));
          threadId = resumed?.thread?.id ?? resumed?.threadId ?? msg.resume;
          bivy({ replyTo: id, ok: true, runtimeSessionRef: threadId });
          return;
        }
        const started = await asRequest("thread/start", threadParams(msg));
        threadId = started?.thread?.id ?? started?.threadId ?? null;
        bivy({ replyTo: id, ok: true, runtimeSessionRef: threadId });
        return;
      }
      case "session.resume": {
        await ensureInitialized();
        const resumeRef = String(msg.runtimeSessionRef || msg.resumeRef || msg.sessionId || "");
        if (!resumeRef) { bivy({ replyTo: id, ok: false, error: "missing resume ref" }); return; }
        const resumed = await asRequest("thread/resume", threadParams(msg, { threadId: resumeRef }));
        threadId = resumed?.thread?.id ?? resumed?.threadId ?? resumeRef;
        bivy({ replyTo: id, ok: true, runtimeSessionRef: threadId });
        return;
      }
      case "chat.send": {
        if (!threadId) { bivy({ replyTo: id, ok: false, error: "no codex thread" }); return; }
        // Ack immediately. The turn's lifecycle — assistant deltas, per-tool
        // approval cards, completion — is delivered through the streamed
        // session.status / session.done / session.error events below, NOT through
        // this reply. Deferring the ack until turn/completed made ProtocolRuntime's
        // 30s command timeout (src/runtime/protocol.ts) fire on any turn that ran
        // longer than 30s — which, for this approvals runtime, is essentially every
        // turn, since it can't complete until the human taps Approve on each card.
        // That rejected the prompt ("chat.send timed out"), stranded the session,
        // and forced a fresh thread on the next message.
        bivy({ replyTo: id, ok: true });
        asRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: String(msg.text ?? "") }],
          ...(selectedModel ? { model: selectedModel } : {}),
        })
          .catch((error) => bivy({ type: "session.error", error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      case "model.set": {
        const model = String(msg.model || "").trim();
        if (!model || !models.some((entry) => entry.id === model)) {
          bivy({ replyTo: id, ok: false, error: "unknown Codex model: " + (model || "(empty)") });
          return;
        }
        if (threadId) await asRequest("thread/settings/update", { threadId, model });
        selectedModel = model;
        bivy({ replyTo: id, ok: true, model });
        return;
      }
      case "tool.decision": {
        const reqId = approvalRequests.get(msg.toolCallId);
        if (reqId !== undefined) {
          approvalRequests.delete(msg.toolCallId);
          const decision = msg.decision === "deny" ? "decline" : "accept";
          asReply(reqId, { decision });
        }
        return;
      }
      case "session.abort": {
        if (threadId) await asRequest("turn/interrupt", { threadId }).catch(() => {});
        if (id !== undefined) bivy({ replyTo: id, ok: true });
        return;
      }
      default:
        if (id !== undefined) bivy({ replyTo: id, ok: true });
        return;
    }
  } catch (error) {
    if (id !== undefined) bivy({ replyTo: id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// Announce capabilities; ProtocolRuntime finalizes them from this handshake.
// resume: true — thread/resume reconnects a prior thread by its rollout id
// (verified against codex-cli 0.144.1); the resume plumbing is Bivy-side.
async function announceHello() {
  try {
    await ensureInitialized();
    let cursor = null;
    const catalog = [];
    do {
      const result = await asRequest("model/list", cursor ? { cursor } : {});
      if (Array.isArray(result?.data)) catalog.push(...result.data);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    } while (cursor);
    models = catalog.filter((model) => model && typeof model.id === "string" && !model.hidden).map((model) => ({
      provider: "openai", id: model.id,
      name: typeof model.displayName === "string" && model.displayName ? model.displayName : model.id,
      reasoning: Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0,
    }));
    selectedModel = catalog.find((model) => model?.isDefault && !model.hidden)?.id ?? models[0]?.id ?? null;
  } catch (error) {
    process.stderr.write("[codex-app-server] model discovery failed: " + String(error) + "\n");
  }
  bivy({ type: "hello", runtime: { models, ...(selectedModel ? { currentModel: selectedModel } : {}), capabilities: { toolInterception: true, modelSelection: models.length > 0, resume: true } } });
}

void announceHello();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void onBivyCommand(msg);
});
