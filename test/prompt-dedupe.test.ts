// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #154 (queued follow-ups): duplicate-delivery prevention for `prompt`,
// keyed by clientMessageId. AppController.retryStuckFollowups resends a
// follow-up verbatim (same clientMessageId) after a reconnect when it can't
// tell whether the original send reached the node before the socket dropped.
// src/server.ts makes that safe by wrapping the broadcast + runtime.prompt()
// call in createSessionNewDedupe (the same generic requestId->promise cache
// session.new already uses — see session-new-dedupe.test.ts for its core
// semantics), keyed by clientMessageId instead of requestId. This test
// exercises that exact reuse shape rather than re-proving the generic dedupe
// mechanism itself.
import { strict as assert } from "node:assert";
import test from "node:test";

import { createSessionNewDedupe } from "../src/session/session-new-dedupe.js";

test("prompt dedupe: a retried clientMessageId after a reconnect joins the original broadcast + turn instead of double-prompting", async () => {
  const dedupe = createSessionNewDedupe<void>();
  const broadcasts: string[] = [];
  let turnsStarted = 0;

  function handlePrompt(clientMessageId: string | undefined, text: string) {
    return dedupe.run(clientMessageId, async () => {
      broadcasts.push(text);
      turnsStarted++;
      await Promise.resolve(); // stand-in for the awaited runtime.prompt() call
    });
  }

  // Original send.
  await handlePrompt("cm-1", "do the thing");
  // The client wasn't sure the first send landed before the socket dropped —
  // AppController.retryStuckFollowups resends verbatim on reconnect.
  await handlePrompt("cm-1", "do the thing");

  assert.deepEqual(broadcasts, ["do the thing"], "the retry must not re-broadcast session.user_message a second time");
  assert.equal(turnsStarted, 1, "the retry must not start a second runtime turn for the same follow-up");
});

test("prompt dedupe: distinct clientMessageIds (genuinely different follow-ups) are never conflated", async () => {
  const dedupe = createSessionNewDedupe<void>();
  const broadcasts: string[] = [];

  function handlePrompt(clientMessageId: string | undefined, text: string) {
    return dedupe.run(clientMessageId, async () => {
      broadcasts.push(text);
      await Promise.resolve();
    });
  }

  await handlePrompt("cm-1", "first follow-up");
  await handlePrompt("cm-2", "second follow-up");

  assert.deepEqual(broadcasts, ["first follow-up", "second follow-up"]);
});

test("prompt dedupe: an absent clientMessageId (older client / a caller that never set one) is never deduped", async () => {
  const dedupe = createSessionNewDedupe<void>();
  let calls = 0;

  function handlePrompt(clientMessageId: string | undefined) {
    return dedupe.run(clientMessageId, async () => {
      calls++;
      await Promise.resolve();
    });
  }

  await handlePrompt(undefined);
  await handlePrompt(undefined);

  assert.equal(calls, 2, "no clientMessageId means no dedup key, so every call runs — unchanged pre-#154 behavior");
});
