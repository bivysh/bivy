import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodeUpdateChecker, updateRegistryUrl, type NodeUpdateState } from "../src/node-update.js";

test("checks the install's recorded channel, with safe defaults and override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-channel-"));
  try {
    assert.ok(updateRegistryUrl(dir).endsWith("/latest"));
    fs.writeFileSync(path.join(dir, "channel"), "staging\n");
    assert.ok(updateRegistryUrl(dir).endsWith("/staging"));
    assert.equal(updateRegistryUrl(dir, "https://example.test/release"), "https://example.test/release");
    fs.writeFileSync(path.join(dir, "channel"), "../bad");
    assert.ok(updateRegistryUrl(dir).endsWith("/latest"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [current, latest, expected] of [
  ["0.16.13-staging.2", "0.16.12", false],
  ["0.16.13-staging.2", "0.16.13-staging.10", true],
  ["0.16.13-staging.10", "0.16.13-staging.2", false],
  ["0.16.13-staging.2", "0.16.13", true],
  ["0.16.13", "0.16.13", false],
] as const) {
  test(`semver ${current} → ${latest}`, async () => {
    const checker = createNodeUpdateChecker({ current, registryUrl: () => "test", publish: () => {},
      fetch: async () => Response.json({ version: latest }) });
    await checker.check();
    assert.equal(checker.snapshot().latest, expected ? latest : undefined);
    assert.equal(checker.snapshot().current, current);
  });
}

test("clears obsolete notices, replays clear state, throttles and rechecks on channel change", async () => {
  let time = 0;
  let url = "staging";
  let version = "2.0.0";
  let calls = 0;
  const events: NodeUpdateState[] = [];
  const checker = createNodeUpdateChecker({ current: "1.0.0", now: () => time,
    registryUrl: () => url, publish: (event) => events.push(event),
    fetch: async () => { calls++; return Response.json({ version }); } });
  assert.deepEqual(checker.snapshot(), { type: "node.update", current: "1.0.0" });
  await Promise.all([checker.check(), checker.check()]);
  await checker.check();
  assert.equal(calls, 1);
  version = "1.0.0";
  time += 6 * 60 * 60 * 1000;
  await checker.check();
  assert.equal(events.at(-1)?.latest, undefined);
  assert.deepEqual(checker.snapshot(), { type: "node.update", current: "1.0.0" });
  url = "latest";
  await checker.check();
  assert.equal(calls, 3);
});

test("failed and malformed checks retain state and can retry", async () => {
  let time = 0;
  let response = Response.json({ version: "2.0.0" });
  const checker = createNodeUpdateChecker({ current: "1.0.0", now: () => time,
    registryUrl: () => "test", publish: () => {}, fetch: async () => response.clone() });
  await checker.check();
  time += 6 * 60 * 60 * 1000;
  for (const failed of [new Response(null, { status: 503 }), Response.json({ version: "bad" })]) {
    response = failed;
    await checker.check();
    assert.equal(checker.snapshot().latest, "2.0.0");
  }
  response = Response.json({ version: "1.0.0" });
  await checker.check();
  assert.equal(checker.snapshot().latest, undefined);
});
