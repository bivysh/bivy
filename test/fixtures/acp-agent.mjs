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
      // An agent with a reasoning-effort option (Grok's shape): ACP category
      // "thought_level" beside the model option.
      reply(id, process.env.ACP_THOUGHT_LEVELS === "1"
        ? { sessionId, configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "fixture/m1", options: [{ value: "fixture/m1", name: "M1" }] },
          { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
        ] }
        : { sessionId });
      return;
    case "session/set_config_option":
      if (process.env.BIVY_TEST_CONFIG_DUMP) fs.writeFileSync(process.env.BIVY_TEST_CONFIG_DUMP, JSON.stringify(params));
      reply(id, {});
      return;
    case "session/load":
      if (process.env.ACP_FAIL_LOAD === "1") { replyError(id, "fixture refused session/load"); return; }
      sessionId = params?.sessionId ?? sessionId;
      // Spec behavior: replay the conversation as session/update before replying.
      if (process.env.ACP_LOAD_REPLAY === "1") {
        notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "old thought" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" } } });
      }
      reply(id, { sessionId });
      return;
    case "session/cancel":
      return; // notification
    case "session/prompt": {
      if (process.env.BIVY_TEST_PROMPT_DUMP) {
        try { fs.writeFileSync(process.env.BIVY_TEST_PROMPT_DUMP, JSON.stringify(params?.prompt ?? null)); } catch { /* ignore */ }
      }
      // An edit tool that asks permission, then performs the edit through the
      // client's fs/write_text_file (Grok's shape): one approval, not two.
      if (process.env.ACP_APPROVED_EDIT_PATH) {
        const file = process.env.ACP_APPROVED_EDIT_PATH;
        const granted = new Promise((resolve) => { permResolve = resolve; });
        send({ jsonrpc: "2.0", id: 9101, method: "session/request_permission", params: {
          sessionId,
          toolCall: { toolCallId: "edit1", title: "search_replace", kind: "edit", locations: [{ path: file }], rawInput: { file_path: file } },
          options: [ { optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" } ],
        } });
        granted.then(() => {
          const written = new Promise((resolve) => clientResponses.set(9102, resolve));
          send({ jsonrpc: "2.0", id: 9102, method: "fs/write_text_file", params: { sessionId, path: file, content: "edited" } });
          return written;
        }).then(() => {
          notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "edit1", status: "completed" } });
          reply(id, { stopReason: "end_turn" });
        });
        return;
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
      // Simulate opencode's execute tool: the command's stdout streams in an
      // in_progress update, and the closing (completed) update carries NO
      // content — the shim must still surface the streamed output, not "completed".
      if (process.env.ACP_SPLIT_TOOL_OUTPUT === "1") {
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "split1", title: "run ls", kind: "execute", rawInput: { command: "ls" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "split1", status: "in_progress", content: { type: "text", text: "file-a.txt\nfile-b.txt" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "split1", status: "completed" } });
      }
      // Simulate a spec-compliant ACP agent (opencode) that reports a tool's
      // output as the canonical ToolCallContent wrapper `{ type: "content",
      // content: { type: "text", text } }` rather than a bare ContentBlock. The
      // shim must unwrap it, not drop it and collapse the result to "completed".
      if (process.env.ACP_WRAPPED_TOOL_OUTPUT === "1") {
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "wrapped1", title: "read file", kind: "read", rawInput: { path: "sample.txt" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "wrapped1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hello world from testfile" } }] } });
      }
      // A sub-agent that runs as its own ACP session (Grok's spawn_subagent):
      // the delegating call opens titled with its tool name and is retitled with
      // prose, then the child's prose and tools stream tagged with the CHILD's
      // sessionId after the (background) spawn call already completed.
      if (process.env.ACP_SUBAGENT === "1") {
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "sub1", title: "spawn_subagent", kind: "other", rawInput: {} } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "sub1", title: "Count lines", rawInput: { description: "Count lines", prompt: "count README lines" } } });
        notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "sub1", status: "completed", content: { type: "text", text: "started" } } });
        notify("session/update", { sessionId: "child-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child prose" } } });
        notify("session/update", { sessionId: "child-1", update: { sessionUpdate: "tool_call", toolCallId: "child-tool", title: "wc -l README.md", kind: "execute", rawInput: { command: "wc -l README.md" } } });
        notify("session/update", { sessionId: "child-1", update: { sessionUpdate: "tool_call_update", toolCallId: "child-tool", status: "completed", content: { type: "text", text: "2 README.md" } } });
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
