#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// A minimal STUB Agent Client Protocol (ACP) agent for testing bin/acp-shim.mjs.
// Speaks newline-delimited JSON-RPC 2.0 over stdio, implementing just enough of
// ACP to exercise the shim end-to-end: initialize, session/new, session/load, and
// a session/prompt turn that streams an assistant message, requests one tool
// permission, and (once granted) reports the tool completed before finishing.
import { createInterface } from "node:readline";

function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }

let sessionId = "acp-session-1";
let permResolve = null; // resolves when the client answers our permission request

createInterface({ input: process.stdin }).on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }

  // Responses to OUR requests (permission).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    if (permResolve) { permResolve(msg.result); permResolve = null; }
    return;
  }

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } });
      return;
    case "session/new":
      reply(id, { sessionId });
      return;
    case "session/load":
      sessionId = params?.sessionId ?? sessionId;
      reply(id, { sessionId });
      return;
    case "session/cancel":
      return; // notification
    case "session/prompt": {
      // Stream an assistant message chunk.
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from ACP" } } });
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
      });
      return;
    }
    default:
      if (id !== undefined) reply(id, {});
      return;
  }
});
