#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/** Minimal ACP agent for plugin authoring and conformance examples. */
import { createInterface } from "node:readline";

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }

const sessionId = "example-session";
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (method === "initialize") {
    reply(id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } });
  } else if (method === "session/new" || method === "session/load") {
    reply(id, { sessionId: params?.sessionId ?? sessionId });
  } else if (method === "session/prompt") {
    const text = params?.prompt?.find?.((part) => part?.type === "text")?.text ?? "Hello";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params?.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Example agent received: ${text}` } },
      },
    });
    reply(id, { stopReason: "end_turn" });
  }
});
