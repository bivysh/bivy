#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// A minimal STUB Agent Client Protocol (ACP) agent for testing bin/acp-shim.mjs.
// Speaks newline-delimited JSON-RPC 2.0 over stdio, implementing just enough of
// ACP to exercise the shim end-to-end: initialize, session/new, session/load, and
// a session/prompt turn that streams an assistant message, requests one tool
// permission, and (once granted) reports the tool completed before finishing.
import { createInterface } from "node:readline";
import fs from "node:fs";

function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, message) { send({ jsonrpc: "2.0", id, error: { code: -32000, message } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }

let sessionId = "acp-session-1";
let permResolve = null; // resolves when the client answers our permission request
const clientResponses = new Map();

createInterface({ input: process.stdin }).on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }

  // Responses to OUR requests (permission).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const resolve = clientResponses.get(msg.id);
    if (resolve) { clientResponses.delete(msg.id); resolve(msg); return; }
    if (permResolve) { permResolve(msg.result); permResolve = null; }
    return;
  }

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } });
      return;
    case "session/new":
      // Record the mcpServers the shim advertised, so a test can assert Bivy's
      // MCP passthrough (3A) reached the agent instead of the old hardcoded [].
      if (process.env.BIVY_TEST_MCP_DUMP) {
        try { fs.writeFileSync(process.env.BIVY_TEST_MCP_DUMP, JSON.stringify(params?.mcpServers ?? null)); } catch { /* ignore */ }
      }
      reply(id, { sessionId });
      return;
    case "session/load":
      if (process.env.ACP_FAIL_LOAD === "1") { replyError(id, "fixture refused session/load"); return; }
      sessionId = params?.sessionId ?? sessionId;
      reply(id, { sessionId });
      return;
    case "session/cancel":
      return; // notification
    case "session/prompt": {
      if (process.env.BIVY_TEST_PROMPT_DUMP) {
        try { fs.writeFileSync(process.env.BIVY_TEST_PROMPT_DUMP, JSON.stringify(params?.prompt ?? null)); } catch { /* ignore */ }
      }
      if (process.env.ACP_FS_WRITE_PATH) {
        const requestId = 8001;
        const response = new Promise((resolve) => clientResponses.set(requestId, resolve));
        send({ jsonrpc: "2.0", id: requestId, method: "fs/write_text_file", params: { sessionId, path: process.env.ACP_FS_WRITE_PATH, content: "written by ACP fixture" } });
        response.then((message) => {
          if (process.env.BIVY_TEST_FS_RESULT_DUMP) fs.writeFileSync(process.env.BIVY_TEST_FS_RESULT_DUMP, JSON.stringify(message));
          reply(id, { stopReason: "end_turn" });
        });
        return;
      }
      // Stream an assistant message chunk.
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from ACP" } } });
      // Activity notifications describe work that may already be running. They
      // must be observed, never presented as a decision that can still stop it.
      if (process.env.ACP_AUTO_TOOL === "1") {
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "auto1", title: "automatic read", kind: "read", rawInput: { path: "README.md" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "auto1", status: "completed", content: { type: "text", text: "done" } } });
      }
      // Request permission to run a tool, then finish once granted.
      const permId = 9001;
      const done = new Promise((res) => { permResolve = res; });
      send({ jsonrpc: "2.0", id: permId, method: "session/request_permission", params: {
        sessionId,
        toolCall: { toolCallId: "tc1", title: "run ls", kind: "execute", rawInput: { command: "ls" } },
        options: [ { optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" } ],
      } });
      done.then((outcome) => {
        const granted = outcome?.outcome?.outcome === "selected" && outcome.outcome.optionId === "ok";
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: granted ? "completed" : "failed", content: { type: "text", text: granted ? "file.txt" : "denied" } } });
        reply(id, { stopReason: "end_turn" });
        // Simulate the opencode ACP end_turn race (opencode#17505): the LAST
        // agent_message_chunk frames are emitted AFTER the session/prompt reply —
        // the reply resolves, and the tail lands a moment later. The shim must
        // hold session.done until this tail is drained, or the interim message
        // streams live but never persists to history.
        if (process.env.ACP_TRAILING_CHUNK === "1") {
          setTimeout(() => {
            notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " — trailing tail that must survive reopen" } } });
          }, 30);
        }
      });
      return;
    }
    default:
      if (id !== undefined) reply(id, {});
      return;
  }
});
