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

    // save() (fsync path) actually persisted a well-formed file.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
    assert.equal(onDisk.sessions.a.status, "working", "round-trips through fsync save");

    // resetStaleWorking clears only 'working', persists, and reports the count.
    const reset = store.resetStaleWorking();
    assert.equal(reset, 2, "resets both working rows");

    const reloaded = MetadataStore.load(dir);
    const byId = Object.fromEntries(reloaded.listSessions().map((s) => [s.id, s.status]));
    assert.equal(byId.a, "idle", "a reset to idle");
    assert.equal(byId.b, "idle", "b untouched");
    assert.equal(byId.c, "idle", "c reset to idle");

    // Idempotent: nothing left to reset.
    assert.equal(reloaded.resetStaleWorking(), 0, "second reset is a no-op");

    console.log("metadata: all tests passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run();
