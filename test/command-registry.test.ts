// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { CommandRegistry } from "../src/protocol/command-registry.js";
import { CLIENT_COMMAND_ROUTES } from "../src/protocol/client-command-routes.js";
import { CLIENT_COMMAND_SCHEMAS } from "../src/protocol/client-command-schemas.js";

test("command registry validates before invoking a handler", async () => {
  const handled: unknown[] = [];
  const replies: unknown[] = [];
  const registry = new CommandRegistry<{ kind: string; requestId?: string; name?: unknown }>({
    rename: (input) => { handled.push(input); },
  }, {
    rename: Type.Object({ kind: Type.Literal("rename"), requestId: Type.Optional(Type.String()), name: Type.String() }),
  });
  const ctx = { reply: (event: unknown) => replies.push(event), broadcast: () => undefined };

  assert.deepEqual(await registry.dispatch("unknown", { kind: "unknown" }, ctx), { handled: false, valid: true });
  assert.deepEqual(await registry.dispatch("rename", { kind: "rename", requestId: "r1", name: 42 }, ctx), { handled: true, valid: false });
  assert.equal(handled.length, 0);
  assert.match(String((replies[0] as { error?: unknown }).error), /Invalid rename/);
  assert.equal((replies[0] as { requestId?: unknown }).requestId, "r1");

  assert.deepEqual(await registry.dispatch("rename", { kind: "rename", name: "Machine" }, ctx), { handled: true, valid: true });
  assert.deepEqual(handled, [{ kind: "rename", name: "Machine" }]);
});

test("every generated HTTP command route validates through the shared schema table", () => {
  for (const route of CLIENT_COMMAND_ROUTES) {
    assert.ok(CLIENT_COMMAND_SCHEMAS[route.kind], `${route.kind} needs a command-boundary schema`);
  }
});

test("inline schemas remain supported while schemas migrate to the data table", async () => {
  let calls = 0;
  const registry = new CommandRegistry<{ kind: string; count?: unknown }>({
    count: {
      since: 1,
      schema: Type.Object({ kind: Type.Literal("count"), count: Type.Number() }),
      handler: () => { calls += 1; },
    },
  });
  const ctx = { reply: () => undefined, broadcast: () => undefined };
  await registry.dispatch("count", { kind: "count", count: "bad" }, ctx);
  await registry.dispatch("count", { kind: "count", count: 1 }, ctx);
  assert.equal(calls, 1);
});
