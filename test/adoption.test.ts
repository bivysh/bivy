// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { attachAdoptedSessions, classifyAttachFailure } from "../src/runtime/adoption.js";
import type { SessionLocation } from "../src/runtime/session-location.js";

function loc(sessionId: string, agentServiceAddress = "unix:/run/a.sock"): SessionLocation {
  return { sessionId, agentServiceAddress, runtimeId: "claude-code-sdk" };
}

test("classifyAttachFailure: only the 'no detached session' reply is definitively gone", () => {
  assert.equal(classifyAttachFailure(new Error("No detached session to attach: abc")), "gone");
  assert.equal(classifyAttachFailure(new Error("no detached SESSION to attach: abc")), "gone");
  assert.equal(classifyAttachFailure(new Error("connect ECONNREFUSED /run/a.sock")), "transient");
  assert.equal(classifyAttachFailure(new Error("agent service connection closed during start")), "transient");
  assert.equal(classifyAttachFailure("weird non-error"), "transient");
});

test("a reachable-but-empty service forgets the mapping (definitively gone)", async () => {
  const forgotten: string[] = [];
  const outcome = await attachAdoptedSessions([loc("s1")], {
    attach: async () => {
      throw new Error("No detached session to attach: s1");
    },
    forget: async (id) => void forgotten.push(id),
  });
  assert.deepEqual(outcome.forgotten, ["s1"]);
  assert.deepEqual(outcome.adopted, []);
  assert.deepEqual(outcome.kept, []);
  assert.deepEqual(forgotten, ["s1"], "the gone mapping was forgotten");
});

test("an unreachable service KEEPS the mapping (transient) — never forgets", async () => {
  const forgotten: string[] = [];
  const outcome = await attachAdoptedSessions([loc("s1")], {
    attach: async () => {
      throw new Error("connect ECONNREFUSED /run/a.sock");
    },
    forget: async (id) => void forgotten.push(id),
  });
  assert.deepEqual(outcome.kept, ["s1"]);
  assert.deepEqual(outcome.forgotten, []);
  assert.deepEqual(forgotten, [], "a transient failure must NOT forget a possibly-live child");
});

test("a successful attach is adopted", async () => {
  const attached: string[] = [];
  const outcome = await attachAdoptedSessions([loc("s1"), loc("s2", "10.0.0.4:4711")], {
    attach: async (l) => void attached.push(l.sessionId),
    forget: async () => {},
  });
  assert.deepEqual(outcome.adopted.sort(), ["s1", "s2"]);
  assert.deepEqual(attached.sort(), ["s1", "s2"]);
});

test("mixed batch: each session classified independently", async () => {
  const outcome = await attachAdoptedSessions([loc("ok"), loc("gone"), loc("down")], {
    attach: async (l) => {
      if (l.sessionId === "gone") throw new Error("No detached session to attach: gone");
      if (l.sessionId === "down") throw new Error("socket hang up");
    },
    forget: async () => {},
  });
  assert.deepEqual(outcome.adopted, ["ok"]);
  assert.deepEqual(outcome.forgotten, ["gone"]);
  assert.deepEqual(outcome.kept, ["down"]);
});
