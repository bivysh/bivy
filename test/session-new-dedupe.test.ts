// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { createSessionNewDedupe } from "../src/session/session-new-dedupe.js";

// Manual eviction harness: capture the scheduled eviction callbacks so a
// fulfilled entry's TTL can be fired deterministically without real time.
function manualEviction() {
  const pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
    },
    evictAll() {
      const fns = pending.splice(0);
      for (const fn of fns) fn();
    },
    pendingCount() {
      return pending.length;
    },
  };
}

// A deferred so a "creation" can be held open across concurrent callers.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("dedupe: a racing retry joins the in-flight creation instead of starting a second", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const gate = deferred<string>();
  const create = () => {
    creates++;
    return gate.promise;
  };

  // Original + retry both fire while creation is still in flight (before await).
  const a = dedupe.run("req-1", create);
  const b = dedupe.run("req-1", create);
  assert.equal(creates, 1, "create() runs once for a shared requestId");
  assert.equal(dedupe.size(), 1);

  gate.resolve("session-A");
  assert.equal(await a, "session-A");
  assert.equal(await b, "session-A", "both callers adopt the same session");
});

test("dedupe: a later retry (before eviction) adopts the already-created session", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const create = () => {
    creates++;
    return Promise.resolve(`session-${creates}`);
  };

  const first = await dedupe.run("req-1", create);
  // Settled, but not yet evicted — a retry must not create a new session.
  const retry = await dedupe.run("req-1", create);
  assert.equal(creates, 1, "create() is not called again for a cached requestId");
  assert.equal(first, "session-1");
  assert.equal(retry, "session-1", "retry returns the original session");
});

test("dedupe: eviction lets a fresh request with the same requestId create again", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const create = () => {
    creates++;
    return Promise.resolve(`session-${creates}`);
  };

  await dedupe.run("req-1", create);
  assert.equal(evict.pendingCount(), 1, "a fulfilled entry schedules its eviction");
  evict.evictAll();
  assert.equal(dedupe.size(), 0, "entry is dropped after its TTL");

  const again = await dedupe.run("req-1", create);
  assert.equal(creates, 2, "post-eviction, the same requestId creates a new session");
  assert.equal(again, "session-2");
});

test("dedupe: a failed creation is not cached, so a retry can attempt again", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const create = () => {
    creates++;
    return creates === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("session-ok");
  };

  await assert.rejects(dedupe.run("req-1", create), /boom/);
  // Rejection must evict synchronously (no schedule() call), so the map is clear.
  assert.equal(evict.pendingCount(), 0, "a rejected creation does not schedule a TTL eviction");
  assert.equal(dedupe.size(), 0, "a rejected creation is dropped immediately");

  const retry = await dedupe.run("req-1", create);
  assert.equal(creates, 2, "the retry re-attempts creation");
  assert.equal(retry, "session-ok");
});

test("dedupe: no requestId means no dedup (every call creates)", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const create = () => {
    creates++;
    return Promise.resolve(`session-${creates}`);
  };

  const a = await dedupe.run(undefined, create);
  const b = await dedupe.run(undefined, create);
  assert.equal(creates, 2, "an absent requestId is never deduped");
  assert.equal(a, "session-1");
  assert.equal(b, "session-2");
  assert.equal(dedupe.size(), 0, "nothing is tracked without a requestId");
});

test("dedupe: distinct requestIds are independent", async () => {
  const evict = manualEviction();
  const dedupe = createSessionNewDedupe<string>({ schedule: evict.schedule });
  let creates = 0;
  const create = () => {
    creates++;
    return Promise.resolve(`session-${creates}`);
  };

  const a = await dedupe.run("req-1", create);
  const b = await dedupe.run("req-2", create);
  assert.equal(creates, 2);
  assert.equal(a, "session-1");
  assert.equal(b, "session-2");
  assert.equal(dedupe.size(), 2, "each distinct requestId is tracked separately");
});
