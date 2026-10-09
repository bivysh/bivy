// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The cloud computer's session room key is escrowed server-side (sealed at rest
// with the per-account hosted key), keyed by its stable node id. It must survive
// the node being unenrolled so sessions and their snapshots stay readable, and
// the first identity written must win over later concurrent writers.
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";

const store = createPgMemStore();
await store.init();
const acct = await store.findOrCreateAccount("a@example.com");
await store.enrollNode(acct.id, "eph-1", "Ephemeral");
const first = { v: 1, kid: "k1", iv: "aa", ct: "bb", tag: "cc" } as const;
assert.deepEqual(await store.setNodeRoomKeyEncIfAbsent(acct.id, "eph-1", first), first);
assert.equal((await store.setNodeRoomKeyEncIfAbsent(acct.id, "eph-1", { ...first, kid: "k2" })).kid, "k1", "the first escrowed key wins");
await store.removeNode(acct.id, "eph-1");
assert.equal((await store.getNodeRoomKeyEnc(acct.id, "eph-1"))?.kid, "k1", "escrowed room key must survive node removal");
console.log("✓ store escrow keeps the first key and survives node unenroll");
