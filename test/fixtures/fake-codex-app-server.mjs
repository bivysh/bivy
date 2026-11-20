#!/usr/bin/env node
// SPDX-License-Identifier: MIT
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
//   "usage-limit"    → turn/completed with status "failed" carrying turn.error and
//                      NO preceding standalone `error` notification — the shape a
//                      real usage-limit turn takes (codex 0.154). The shim must
//                      still surface it as session.error, never a silent empty turn.
//   "http-401"       → like "usage-limit", but the error is the HTTP variant
//                      Codex uses for a rejected credential.
//   "reconnect"      → an `error` with willRetry: true (Codex reconnecting on its
//                      own), then the "ok" reply: the turn recovered and must
//                      not end failed.
//   "hook"           → hook/started + hook/completed for a preToolUse hook inside
//                      the turn, and a sessionStart hook with no turnId, then "ok".
//   "moderated"      → a shown commentary item, then an answer item whose
//                      item/completed carries moderation.display with the mode in
//                      FAKE_CODEX_DISPLAY (hide | block): the answer is withdrawn.
//   "echo-developer-instructions" → the turn's reply is the developerInstructions
//                      the thread was started/resumed with (empty when none).
import readline from "node:readline";

const MODE = process.env.FAKE_CODEX_MODE || "ok";
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

let threadSeq = 0;
let developerInstructions = "";

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
      developerInstructions = params?.developerInstructions ?? "";
      reply(id, { thread: { id: `thread-${++threadSeq}` } });
      return;
    case "thread/resume":
      developerInstructions = params?.developerInstructions ?? "";
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
      } else if (MODE === "http-401") {
        notify("turn/completed", {
          threadId: params?.threadId,
          turn: { id: "turn-1", status: "failed", error: { message: "unexpected status 401 Unauthorized", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } },
        });
      } else if (MODE === "usage-limit") {
        notify("turn/completed", {
          threadId: params?.threadId,
          turn: { id: "turn-1", status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } },
        });
      } else {
        if (MODE === "hook") {
          const run = (eventName) => ({ id: `hook-${eventName}`, eventName, displayOrder: 0, entries: [], executionMode: "sync", handlerType: "command", scope: "turn", sourcePath: "/tmp/hooks.json", startedAt: 0, status: "running" });
          notify("hook/started", { threadId: params?.threadId, turnId: null, run: run("sessionStart") });
          notify("hook/started", { threadId: params?.threadId, turnId: "turn-1", run: run("preToolUse") });
          notify("hook/completed", { threadId: params?.threadId, turnId: "turn-1", run: { ...run("preToolUse"), status: "completed" } });
        }
        if (MODE === "moderated") {
          const item = (id, text, moderation) => ({ threadId: params?.threadId, turnId: "turn-1", item: { type: "agentMessage", id, text, ...(moderation ? { moderation } : {}) } });
          notify("item/agentMessage/delta", { threadId: params?.threadId, itemId: "item-0", delta: "Looking." });
          notify("item/completed", item("item-0", "Looking."));
          notify("item/agentMessage/delta", { threadId: params?.threadId, itemId: "item-1", delta: "WITHDRAWN" });
          const mode = process.env.FAKE_CODEX_DISPLAY;
          const display = mode === "hide" ? { version: 1, mode, replacement: { kind: "wellbeingPromptHelpline" } } : { version: 1, mode, reason: { kind: "cyber" } };
          notify("item/completed", item("item-1", "WITHDRAWN", { moderated: true, display }));
          notify("turn/completed", { threadId: params?.threadId });
          reply(id, {});
          return;
        }
        if (MODE === "reconnect") notify("error", { threadId: params?.threadId, turnId: "turn-1", willRetry: true, error: { message: "Reconnecting... 1/5 (stream disconnected before completion)" } });
        notify("item/agentMessage/delta", { itemId: "item-1", delta: MODE === "echo-input" ? JSON.stringify(params.input) : MODE === "echo-developer-instructions" ? developerInstructions || "(none)" : "BANANA" });
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
