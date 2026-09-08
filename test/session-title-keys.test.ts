// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalStore, Transport } from "@bivy/core";
import { SessionTitleKeys } from "../packages/web/src/store/session-title-keys.js";

function fixture() {
  const keys: Record<string, string> = { selected: "key" };
  const local = { cur: "selected", keys: () => keys } as LocalStore;
  const connections: Array<{ store: LocalStore; ready: () => void; closed: boolean }> = [];
  let refreshes = 0;
  const loader = new SessionTitleKeys(local, (store, ready) => {
    const connection = { store, ready, closed: false };
    connections.push(connection);
    return {
      connect: async () => {},
      close: () => { connection.closed = true; },
    } as Transport;
  }, () => { refreshes++; });
  return { loader, local, keys, connections, refreshes: () => refreshes };
}

test("missing title keys pair in the background, once per machine, without selecting it", () => {
  const f = fixture();
  try {
    f.loader.ensure(["selected", "other", "other"]);
    f.loader.ensure(["other"]);
    assert.equal(f.connections.length, 1);
    const connection = f.connections[0];
    assert.equal(connection.store.cur, "other");
    assert.equal(f.local.cur, "selected");
    assert.equal(connection.store.keys(), f.keys);
    connection.ready();
    assert.equal(f.refreshes(), 0, "online alone is not enough without a key");
    f.keys.other = "decryption-key";
    connection.ready();
    assert.equal(connection.closed, true);
    assert.equal(f.refreshes(), 1);
    f.loader.ensure(["other"]);
    assert.equal(f.connections.length, 1);
    assert.equal(f.local.cur, "selected");
  } finally { f.loader.close(); }
});

test("bounds background connections and closes them on sign-out", () => {
  const f = fixture();
  f.loader.ensure(["a", "b", "c", "d"]);
  assert.equal(f.connections.length, 3);
  f.keys.a = "key";
  f.connections[0].ready();
  assert.equal(f.connections.length, 4, "a freed slot loads the next machine");
  f.loader.close();
  f.loader.ensure(["unvisited-after-signout"]);
  assert.equal(f.connections.length, 4);
  assert.ok(f.connections.every((connection) => connection.closed));
  f.keys.b = "key";
  f.connections[1].ready();
  assert.equal(f.refreshes(), 1, "late pairing does not refresh after sign-out");
});
