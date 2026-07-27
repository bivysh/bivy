import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetadataStore } from "../src/metadata.js";

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-meta-"));
  try {
    const store = MetadataStore.load(dir);
    store.upsertSession({ id: "a", status: "working" });
    store.upsertSession({ id: "b", status: "idle" });
    store.upsertSession({ id: "c", status: "working" });

    // Writes are coalesced/debounced now; flushSync() forces the pending write
    // so we can assert the fsync path produced a well-formed file on disk.
    store.flushSync();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    assert.equal(onDisk.sessions.a.status, "working", "round-trips through fsync save");

    // resetStaleWorking clears only 'working', persists, and reports the ids it
    // reset (the sessions cut off mid-turn — what the resume reconciler picks up).
    const reset = store.resetStaleWorking();
    assert.deepEqual([...reset].sort(), ["a", "c"], "reports both working ids");

    store.flushSync();
    const reloaded = MetadataStore.load(dir);
    const byId = Object.fromEntries(reloaded.listSessions().map((s) => [s.id, s.status]));
    assert.equal(byId.a, "idle", "a reset to idle");
    assert.equal(byId.b, "idle", "b untouched");
    assert.equal(byId.c, "idle", "c reset to idle");

    // Idempotent: nothing left to reset.
    assert.deepEqual(reloaded.resetStaleWorking(), [], "second reset is a no-op");

    // resumePending is durable and self-clearing: set, round-trips, clears, and
    // no-ops when already in the requested state.
    reloaded.setResumePending("a", true);
    reloaded.setResumePending("missing", true); // no row → no-op, no throw
    reloaded.flushSync();
    const afterPending = MetadataStore.load(dir);
    assert.equal(afterPending.getSession("a")?.resumePending, true, "resumePending persisted");
    assert.equal(afterPending.getSession("missing"), undefined, "no phantom row created");
    afterPending.setResumePending("a", false);
    afterPending.flushSync();
    assert.equal(MetadataStore.load(dir).getSession("a")?.resumePending, false, "resumePending cleared");

    console.log("metadata: all tests passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run();
