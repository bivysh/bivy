import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeIdentity } from "../src/identity.js";

/**
 * Unit tests for the node identity + device-token store persisted to
 * `.bivy/node.json`. Covers the normal create/reload/device lifecycle plus the
 * reliability guarantees added for #110: atomic writes, no silent
 * regeneration on a corrupt file, and private file/dir permissions.
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-identity-"));
}

test("a fresh identity is created with a stable nodeId", () => {
  const dir = tmpDir();
  const identity = NodeIdentity.load(dir);
  assert.ok(identity.nodeId.startsWith("node_"));
  assert.ok(fs.existsSync(path.join(dir, "node.json")));
});

test("identity persists across reload", () => {
  const dir = tmpDir();
  const first = NodeIdentity.load(dir);
  const id = first.nodeId;
  const reloaded = NodeIdentity.load(dir);
  assert.equal(reloaded.nodeId, id);
});

test("createDevice / listDevices / verifyToken / revokeDevice roundtrip", () => {
  const dir = tmpDir();
  const identity = NodeIdentity.load(dir);
  const { device, token } = identity.createDevice("My Phone");
  assert.equal(identity.listDevices().length, 1);
  assert.equal(identity.verifyToken(token), device.id);
  assert.equal(identity.verifyToken("not-a-real-token"), null);

  // Persisted across reload too.
  const reloaded = NodeIdentity.load(dir);
  assert.equal(reloaded.listDevices().length, 1);
  assert.equal(reloaded.verifyToken(token), device.id);

  assert.equal(reloaded.revokeDevice(device.id), true);
  assert.equal(reloaded.listDevices().length, 0);
  assert.equal(reloaded.verifyToken(token), null);
});

test("a corrupt node.json throws instead of silently minting a new identity", () => {
  const dir = tmpDir();
  const file = path.join(dir, "node.json");
  fs.writeFileSync(file, "{not valid json");
  assert.throws(() => NodeIdentity.load(dir), /corrupt/i);
  // The corrupt file must be left exactly as-is — no regeneration attempt.
  assert.equal(fs.readFileSync(file, "utf8"), "{not valid json");
});

test("a missing node.json is the normal first-run case (no throw)", () => {
  assert.doesNotThrow(() => NodeIdentity.load(tmpDir()));
});

test("persist() writes atomically: no leftover .tmp file, private permissions", () => {
  const dir = tmpDir();
  const identity = NodeIdentity.load(dir);
  identity.createDevice("Another device");
  assert.equal(fs.existsSync(path.join(dir, "node.json.tmp")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "data dir should be created with mode 0700");
    assert.equal(fs.statSync(path.join(dir, "node.json")).mode & 0o777, 0o600);
  }
});

console.log(`\nAll ${passed} identity tests passed.`);
