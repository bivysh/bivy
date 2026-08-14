// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandRegistry } from "../src/protocol/command-registry.js";
import { createSessionControlCommands } from "../src/controllers/session-control.js";

const session = { id: "s1" };

test("session control commands share lookup and effect ports", async () => {
  const effects: string[] = [];
  const replies: any[] = [];
  const commands = createSessionControlCommands({
    resolve: (id) => id === "s1" ? session : undefined,
    pause: (value) => effects.push(`pause:${value.id}`),
    resume: (value) => effects.push(`resume:${value.id}`),
    answer: (value, requestId) => effects.push(`answer:${value.id}:${requestId}`),
  });
  const registry = new CommandRegistry(commands);
  const ctx = { reply: (event: unknown) => replies.push(event), broadcast: () => undefined };

  await registry.dispatch("session.pause", { kind: "session.pause", sessionId: "missing" }, ctx);
  assert.equal(replies[0].httpStatus, 404);
  await registry.dispatch("session.pause", { kind: "session.pause", sessionId: "s1" }, ctx);
  await registry.dispatch("session.resume", { kind: "session.resume", sessionId: "s1" }, ctx);
  await registry.dispatch("session.question.answer", { kind: "session.question.answer", sessionId: "s1", requestId: "q1" }, ctx);

  assert.deepEqual(effects, ["pause:s1", "resume:s1", "answer:s1:q1"]);
  assert.deepEqual(replies.slice(1).map((reply) => reply.ok), [true, true, true]);
});
