// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../packages/core/src/store.js";
import { requestNodeUpdate } from "../packages/web/src/store/node-update.js";

function setup() {
  const store = new SessionStore();
  store.setCurrentNode("one");
  store.apply({ type: "node.update", current: "1.0.0", latest: "2.0.0" });
  return store;
}

test("a missing update acknowledgement times out and permits retry without hiding the banner", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = setup();
  let sends = 0;
  requestNodeUpdate(store, () => { sends++; });
  requestNodeUpdate(store, () => { sends++; });
  assert.equal(sends, 1);
  assert.equal(store.getState().connection.nodeUpdating, true);
  t.mock.timers.tick(15_000);
  assert.equal(store.getState().connection.nodeUpdating, false);
  assert.ok(store.getState().connection.nodeUpdate);
  assert.match(store.getState().presentation.error!, /may still be updating/);
});

test("startup reply cancels the timeout but keeps the version banner", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = setup();
  requestNodeUpdate(store, () => store.apply({ type: "node.update.result", ok: true }));
  t.mock.timers.tick(15_000);
  assert.equal(store.getState().connection.nodeUpdating, false);
  assert.ok(store.getState().connection.nodeUpdate);
  assert.ok(!store.getState().presentation.error);
});

test("switching machines clears update state and cancels the old timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = setup();
  requestNodeUpdate(store, () => {});
  store.setCurrentNode("two");
  assert.equal(store.getState().connection.nodeUpdate, null);
  assert.equal(store.getState().connection.nodeUpdating, false);
  t.mock.timers.tick(15_000);
  assert.ok(!store.getState().presentation.error);
});

test("a replacement node's up-to-date snapshot clears the banner and timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = setup();
  requestNodeUpdate(store, () => {});
  store.apply({ type: "node.update", current: "2.0.0" });
  t.mock.timers.tick(15_000);
  assert.equal(store.getState().connection.nodeUpdate, null);
  assert.equal(store.getState().connection.nodeUpdating, false);
  assert.ok(!store.getState().presentation.error);
});

test("a rejected startup reply retains its error instead of timing out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = setup();
  requestNodeUpdate(store, () => store.apply({ type: "node.update.result", ok: false, error: "CLI missing" }));
  t.mock.timers.tick(15_000);
  assert.equal(store.getState().connection.nodeUpdating, false);
  assert.equal(store.getState().presentation.error, "CLI missing");
});

test("send failures release the button immediately", async () => {
  for (const send of [() => { throw new Error("offline"); }, () => Promise.reject(new Error("offline"))]) {
    const store = setup();
    requestNodeUpdate(store, send);
    await Promise.resolve();
    assert.equal(store.getState().connection.nodeUpdating, false);
    assert.equal(store.getState().presentation.error, "offline");
  }
});
