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
      // Record the mcpServers the shim advertised, so a test can assert Bivy's
      // MCP passthrough (3A) reached the agent instead of the old hardcoded [].
      if (process.env.BIVY_TEST_MCP_DUMP) {
        try { fs.writeFileSync(process.env.BIVY_TEST_MCP_DUMP, JSON.stringify(params?.mcpServers ?? null)); } catch { /* ignore */ }
      }
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
