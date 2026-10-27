// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalStore, Transport, TransportHandlers } from "@bivy/core";
import { pairWithMachine } from "../packages/web/src/store/machine-pairing.js";

function fixture() {
  const keys: Record<string, string> = {};
  const local = { cur: "selected", keys: () => keys } as LocalStore;
  const links: Array<{ store: LocalStore; handlers: TransportHandlers; closed: boolean }> = [];
  const connect = (store: LocalStore, handlers: TransportHandlers) => {
    const link = { store, handlers, closed: false };
    links.push(link);
    return { connect: async () => {}, close: () => { link.closed = true; } } as Transport;
  };
  return { keys, local, links, connect };
}

test("pairs with a machine without selecting it, and settles once its key is stored", async () => {
  const f = fixture();
  const paired = pairWithMachine(f.local, "cloud", f.connect);
  const link = f.links[0]!;
  assert.equal(link.store.cur, "cloud");
  assert.equal(f.local.cur, "selected");
  link.handlers.onStatus("online");
  f.keys.cloud = "room-key";
  link.handlers.onStatus("online");
  await paired;
  assert.equal(link.closed, true);
  await pairWithMachine(f.local, "cloud", f.connect);
  assert.equal(f.links.length, 1, "a machine whose key this device holds needs no link");
});

test("a refused pairing rejects with the machine's reason", async () => {
  const f = fixture();
  const paired = pairWithMachine(f.local, "cloud", f.connect);
  f.links[0]!.handlers.onError?.("Device limit reached");
  f.links[0]!.handlers.onStatus("offline");
  await assert.rejects(paired, /Device limit reached/);
});

test("replace pairs again over a held key and keeps it until the current one arrives", async () => {
  const f = fixture();
  f.keys.cloud = "old-key";
  f.local.addKey = (id, key) => { f.keys[id] = key; };
  const paired = pairWithMachine(f.local, "cloud", f.connect, { replace: true });
  const link = f.links[0]!;
  assert.equal(link.store.keys().cloud, undefined, "the transport pairs as if it had no key");
  assert.equal(f.keys.cloud, "old-key");
  link.handlers.onStatus("online");
  assert.equal(link.closed, false, "an old key doesn't count as delivered");
  link.store.addKey("cloud", "new-key");
  link.handlers.onStatus("online");
  await paired;
  assert.equal(f.keys.cloud, "new-key");
});
