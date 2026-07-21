import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PairingStore } from "../src/device-registry.js";
import { sealFrame, openFrame } from "../src/e2e.js";
import { newDeviceKeypair, buildHello, acceptWelcome, RoomCipher } from "../src/relay-cli-crypto.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

function freshStore(): PairingStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pair-"));
  return PairingStore.load(dir);
}

// The whole point: a CLI device pairs with the real node PairingStore over the
// (simulated) relay and both ends end up holding the same room key.
check("client pairs with the node and recovers the shared room key", () => {
  const store = freshStore();
  const pairSecret = store.issuePairSecret(); // carried out-of-band (QR/token)

  const kp = newDeviceKeypair();
  const hello = buildHello(pairSecret, kp, "test-cli");
  const welcome = store.handleHello(hello); // node side verifies the proof
  assert.ok(welcome, "node should accept a valid hello");

  const roomKey = acceptWelcome(kp, welcome!);
  assert.ok(roomKey.equals(store.roomKey()), "client room key must equal the node's");
});

check("node→client and client→node frames round-trip under the room key", () => {
  const store = freshStore();
  const secret = store.issuePairSecret();
  const kp = newDeviceKeypair();
  const roomKey = acceptWelcome(kp, store.handleHello(buildHello(secret, kp))!);
  const cipher = new RoomCipher(roomKey);

  // node → client (e.g. terminal.output)
  const outbound = { type: "terminal.output", termId: "t1", data: "hello\r\n" };
  assert.deepEqual(cipher.open(sealFrame(store.roomKey(), outbound)).data, outbound);

  // client → node (e.g. terminal.input)
  const inbound = { kind: "terminal.input", termId: "t1", data: "ls\n" };
  assert.deepEqual(openFrame(store.roomKey(), cipher.seal(inbound)).data, inbound);
});

check("a relay that never saw the pairing secret cannot forge a hello", () => {
  const store = freshStore();
  store.issuePairSecret(); // a real secret exists, but the attacker doesn't have it
  const kp = newDeviceKeypair();
  // Attacker guesses/forges a secret (32 random bytes, base64url).
  const forged = buildHello(Buffer.from("00000000000000000000000000000000").toString("base64url"), kp);
  assert.equal(store.handleHello(forged), null, "forged proof must be rejected");
});

check("a pairing secret is single-use", () => {
  const store = freshStore();
  const secret = store.issuePairSecret();
  const kp = newDeviceKeypair();
  assert.ok(store.handleHello(buildHello(secret, kp)), "first use accepted");
  const kp2 = newDeviceKeypair();
  assert.equal(store.handleHello(buildHello(secret, kp2)), null, "second use of the same secret rejected");
});

check("acceptWelcome rejects a tampered wrapped room key", () => {
  const store = freshStore();
  const secret = store.issuePairSecret();
  const kp = newDeviceKeypair();
  const welcome = store.handleHello(buildHello(secret, kp))!;
  const tampered = { ...welcome, wrapped: welcome.wrapped.slice(0, -4) + (welcome.wrapped.slice(-4) === "AAAA" ? "BBBB" : "AAAA") };
  assert.throws(() => acceptWelcome(kp, tampered), "a tampered wrap must not silently yield a key");
});

if (failures > 0) { console.error(`\n${failures} relay-cli-crypto test(s) failed.`); process.exit(1); }
console.log("\nrelay-cli-crypto tests passed.");
