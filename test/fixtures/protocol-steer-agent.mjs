#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A protocol agent whose first turn is still streaming when a second message
// (a steer) arrives: it says part of a reply, waits, then answers the steer and
// ends the turn. Drives ProtocolRuntime's mid-turn prompt handling.
import readline from "node:readline";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let sends = 0;
send({ type: "hello", runtime: { capabilities: { toolInterception: false } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "session.create") { send({ replyTo: msg.id, ok: true, runtimeSessionRef: "steer-1" }); return; }
  if (msg.type === "chat.send") {
    send({ replyTo: msg.id, ok: true });
    sends += 1;
    if (sends === 1) {
      send({ type: "session.status", status: "working" });
      send({ type: "message.delta", text: "The earlier work is done." });
      return; // still streaming: the turn ends after the steer is answered
    }
    send({ type: "message.delta", text: " Here is the summary." });
    send({ type: "session.status", status: "idle" });
    send({ type: "session.done" });
    return;
  }
  if (msg.id !== undefined) send({ replyTo: msg.id, ok: true });
});
