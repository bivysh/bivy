import assert from "node:assert/strict";
import test from "node:test";
import { forceAbortTurn } from "../src/session/abort-recovery.js";

test("forceAbortTurn settles and notifies before an unresolved runtime abort", async () => {
  const calls: string[] = [];
  forceAbortTurn({
    settle: () => calls.push("settle"),
    notifySettled: () => calls.push("notify"),
    abort: () => {
      calls.push("abort");
      return new Promise<void>(() => {});
    },
  });

  assert.deepEqual(calls, ["settle", "notify"]);
  await Promise.resolve();
  assert.deepEqual(calls, ["settle", "notify", "abort"]);
});

test("forceAbortTurn contains runtime abort failures", async () => {
  const failure = new Error("wedged");
  let seen: unknown;
  forceAbortTurn({
    settle: () => {},
    notifySettled: () => {},
    abort: async () => { throw failure; },
    onAbortError: (error) => { seen = error; },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(seen, failure);
});
