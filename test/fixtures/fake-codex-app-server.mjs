#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A minimal fake of Codex's `app-server` JSON-RPC, enough to drive the real
// bin/codex-app-server-shim.mjs through ProtocolRuntime WITHOUT a Codex install
// or model credentials. The shim spawns `$BIVY_CODEX_BIN app-server`; point
// BIVY_CODEX_BIN at this file and it speaks just the surfaces the shim uses:
// initialize / model/list / thread/start / thread/resume / turn/start /
// turn/interrupt, plus the turn-lifecycle notifications.
//
// FAKE_CODEX_MODE controls how a turn ends:
//   "ok"   (default) → item/agentMessage/delta "BANANA" then turn/completed
//   "fail"           → turn/failed WITHOUT any following turn/completed, which is
//                      exactly the terminal-failure shape that used to wedge the
//                      Bivy session "working" forever (the shim now ends the turn).
import readline from "node:readline";

const MODE = process.env.FAKE_CODEX_MODE || "ok";
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

let threadSeq = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || !method) return; // fake only receives requests

  switch (method) {
    case "initialize":
      reply(id, { serverInfo: { name: "fake-codex", version: "0.0.0" } });
      return;
    case "model/list":
      reply(id, {
        data: [
          { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high"] },
          { id: "gpt-5", displayName: "GPT-5" },
        ],
      });
      return;
    case "thread/start":
      reply(id, { thread: { id: `thread-${++threadSeq}` } });
      return;
    case "thread/resume":
      reply(id, { thread: { id: params?.threadId || `thread-${++threadSeq}` } });
      return;
    case "thread/settings/update":
      reply(id, {});
      return;
    case "turn/interrupt":
      reply(id, {});
      return;
    case "turn/start": {
      // The real app-server streams the turn's lifecycle as notifications, then
      // replies to turn/start. Emit notifications first so the shim processes the
      // terminal event, then ack the request (the shim only .catch()es it).
      notify("turn/started", { threadId: params?.threadId });
      if (MODE === "fail") {
        notify("turn/failed", { error: { message: "simulated codex failure" } });
      } else {
        notify("item/agentMessage/delta", { itemId: "item-1", delta: "BANANA" });
        notify("turn/completed", { threadId: params?.threadId });
      }
      reply(id, {});
      return;
    }
    default:
      // Anything else the shim might send: ack so nothing hangs.
      reply(id, {});
      return;
  }
});
