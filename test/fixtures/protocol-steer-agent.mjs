#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A protocol agent whose first turn is still streaming when a second message
// arrives. By default it advertises steer: it says part of a reply, waits, then
// answers the steer and ends the turn. With --no-steer it is an agent that can't
// steer (ACP's shape): turn 1 ends on its own, and a chat.send that arrives while
// a turn is open is answered "CONCURRENT" so the test can see it was not held.
import readline from "node:readline";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const steer = !process.argv.includes("--no-steer");
let sends = 0;
let open = false;
send({ type: "hello", runtime: { capabilities: { toolInterception: false, ...(steer ? { streamingBehaviors: ["steer"] } : {}) } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "session.create") { send({ replyTo: msg.id, ok: true, runtimeSessionRef: "steer-1" }); return; }
  if (msg.type === "chat.send") {
    send({ replyTo: msg.id, ok: true });
    sends += 1;
    if (sends === 1) {
      open = true;
      send({ type: "session.status", status: "working" });
      send({ type: "message.delta", text: "The earlier work is done." });
      if (!steer) setTimeout(() => {
        send({ type: "message.delta", text: " All of it." });
        open = false;
        send({ type: "session.done" });
      }, 150);
      return; // still streaming
    }
    send({ type: "message.delta", text: steer ? " Here is the summary." : open ? "CONCURRENT" : "Here is the summary." });
    open = false;
    send({ type: "session.status", status: "idle" });
    send({ type: "session.done" });
    return;
  }
  if (msg.id !== undefined) send({ replyTo: msg.id, ok: true });
});
