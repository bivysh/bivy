// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// CRYPTO WIRE-FORMAT CONFORMANCE TEST (Slice 4).
//
// Bivy carries two byte-compatible crypto stacks: the node (node:crypto) and the
// browser/PWA client (WebCrypto). If they drift by a single byte, a paired phone
// can no longer read a node's frames. This test pins BOTH stacks to the shared
// wire-format spec (packages/core/src/wire-format.ts) and asserts they agree
// byte-for-byte across every leg of the wire: the sealed AES-GCM envelope, the
// ECDH+HKDF pairing wrap, the HMAC pairing proof, the frame chunking, and the
// replay guard.
//
// Runs directly under tsx (WebCrypto's crypto.subtle is a Node 22 global), so no
// browser is required. Run: `npx tsx test/crypto-conformance.test.ts`.

import assert from "node:assert/strict";

// --- node stack (node:crypto) ---
import { seal as nSeal, open as nOpen, sealFrame, openFrame, ReplayGuard } from "../src/e2e.js";
import { frameMessages as nFrameMessages, FrameReassembler } from "../src/relay-chunk.js";
import {
  generatePairingKeypair,
  deriveWrapKey,
  generateRoomKey,
  wrapRoomKey,
  pairingProof as nPairingProof,
  generatePairSecret,
} from "../src/pairing-crypto.js";

// --- browser stack (WebCrypto), imported across the package boundary ---
import { importRoomKey, seal as bSeal, open as bOpen, createReplayGuard } from "../packages/core/src/crypto.js";
import { frameMessages as bFrameMessages, createFrameReassembler } from "../packages/core/src/relay-frame.js";
import { wrapKeyFor, pairingProof as bPairingProof } from "../packages/core/src/pairing.js";

// --- the single source of truth, and the node re-export of it ---
import * as coreConst from "../packages/core/src/wire-format.js";
import * as nodeConst from "../src/wire-format.js";
import {
  IV_BYTES,
  SEALED_HEADER_BYTES,
  FRAME_VERSION,
  FRAME_NONCE_BYTES,
  FRAME_CHUNK_BYTES,
  HKDF_INFO,
} from "../packages/core/src/wire-format.js";

let failures = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  const run = (async () => {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
    }
  })();
  pending.push(run);
}

// ---------------------------------------------------------------------------
// 1. Constants: the node mirror (src/wire-format.ts) is byte-for-byte identical
//    to the spec (packages/core/src/wire-format.ts). The node can't re-export the
//    spec — it ships as a standalone `src/`-only bundle (see the header in
//    src/wire-format.ts) — so it keeps a hand-maintained copy. This deep-equals
//    the ENTIRE module namespace, so ANY drift (a changed value OR a new/removed
//    export) fails here. This IS the single-source guarantee.
// ---------------------------------------------------------------------------
check("node wire-format mirror equals the core spec (every export)", () => {
  assert.deepEqual({ ...nodeConst }, { ...coreConst });
});

check("wire-format constants hold their pinned values", () => {
  assert.equal(IV_BYTES, 12);
  assert.equal(SEALED_HEADER_BYTES, 28);
  assert.equal(FRAME_VERSION, 1);
  assert.equal(FRAME_NONCE_BYTES, 12);
  assert.equal(FRAME_CHUNK_BYTES, 192 * 1024);
  assert.equal(HKDF_INFO.pair, "bivy-pair-v1");
  assert.equal(HKDF_INFO.rotate, "bivy-rotate-v1");
  assert.equal(HKDF_INFO.deviceVault, "bivy-device-vault-v1");
});

// The node chunker and browser chunker must use the very same chunk size.
check("node and browser chunkers share one FRAME_CHUNK_BYTES", async () => {
  const relayChunk = await import("../src/relay-chunk.js");
  const relayFrame = await import("../packages/core/src/relay-frame.js");
  assert.equal(relayChunk.FRAME_CHUNK_BYTES, relayFrame.FRAME_CHUNK_BYTES);
  assert.equal(relayChunk.FRAME_CHUNK_BYTES, FRAME_CHUNK_BYTES);
});

// ---------------------------------------------------------------------------
// 2. Sealed envelope round-trips + wire layout.
// ---------------------------------------------------------------------------
check("node seal → node open round-trips", () => {
  const key = generateRoomKey();
  const msg = "hello wire format \u{1f512}";
  assert.equal(nOpen(key, nSeal(key, msg)), msg);
});

check("sealed layout is [ iv(12) | tag(16) | ct ] base64", () => {
  const key = generateRoomKey();
  const packed = Buffer.from(nSeal(key, "x"), "base64");
  // ciphertext of a 1-byte GCM message is 1 byte, so total = header + 1.
  assert.equal(packed.length, SEALED_HEADER_BYTES + 1);
});

check("sealFrame embeds v=FRAME_VERSION and a 12-byte nonce", () => {
  const key = generateRoomKey();
  const env = JSON.parse(nOpen(key, sealFrame(key, { hi: 1 }))) as { v: number; ts: number; nonce: string; data: unknown };
  assert.equal(env.v, FRAME_VERSION);
  assert.equal(typeof env.ts, "number");
  assert.equal(Buffer.from(env.nonce, "base64").length, FRAME_NONCE_BYTES);
  assert.deepEqual(env.data, { hi: 1 });
});

// ---------------------------------------------------------------------------
// 3. Cross-stack seal/open: node ↔ browser agree byte-for-byte.
// ---------------------------------------------------------------------------
check("node-seal → browser-open (and the reverse) agree", async () => {
  const raw = generateRoomKey();
  const bKey = await importRoomKey(new Uint8Array(raw));
  const plaintext = "cross-stack é\u{1f680} payload";

  // node seals, browser opens
  assert.equal(await bOpen(bKey, nSeal(raw, plaintext)), plaintext);
  // browser seals, node opens
  assert.equal(nOpen(raw, await bSeal(bKey, plaintext)), plaintext);
});

check("node-sealed FRAME opens in the browser stack", async () => {
  const raw = generateRoomKey();
  const bKey = await importRoomKey(new Uint8Array(raw));
  const payload = sealFrame(raw, { kind: "terminal.output", data: "ls\n" });
  const env = JSON.parse(await bOpen(bKey, payload)) as { v: number; nonce: string; data: unknown };
  assert.equal(env.v, FRAME_VERSION);
  assert.equal(Buffer.from(env.nonce, "base64").length, FRAME_NONCE_BYTES);
  assert.deepEqual(env.data, { kind: "terminal.output", data: "ls\n" });
});

// ---------------------------------------------------------------------------
// 4. Cross-stack pairing: ECDH + HKDF wrap, and the HMAC proof.
// ---------------------------------------------------------------------------
check("node-wrapped room key unwraps via the browser HKDF wrap key", async () => {
  const node = generatePairingKeypair();
  const device = generatePairingKeypair();
  const roomKey = generateRoomKey();

  // Node side: derive wrap key from node_priv × device_pub, wrap the room key.
  const nodeWrapKey = deriveWrapKey(node.privateKeyB64, device.publicKeyB64, "pair");
  const wrapped = wrapRoomKey(nodeWrapKey, roomKey);

  // Browser side: import the device private key as a WebCrypto X25519 key and
  // derive the SAME AES-GCM wrap key from device_priv × node_pub, then open it.
  const devicePriv = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(Buffer.from(device.privateKeyB64, "base64url")),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const browserWrapKey = await wrapKeyFor(devicePriv, node.publicKeyB64, "pair");
  const unwrapped = Buffer.from(await bOpen(browserWrapKey, wrapped), "base64");
  assert.ok(unwrapped.equals(roomKey), "browser must recover the exact room key the node wrapped");
});

check("node and browser pairing proofs are identical", async () => {
  const secret = generatePairSecret();
  const device = generatePairingKeypair();
  const nodeProof = nPairingProof(secret, device.publicKeyB64);
  const browserProof = await bPairingProof(secret, device.publicKeyB64);
  assert.equal(nodeProof, browserProof);
});

// ---------------------------------------------------------------------------
// 5. Frame chunking split/reassemble, cross-stack both directions.
// ---------------------------------------------------------------------------
check("small payloads are a single un-chunked frame", () => {
  const msgs = nFrameMessages("tiny");
  assert.equal(msgs.length, 1);
  const env = JSON.parse(msgs[0]!) as { t: string; p: string; fc?: unknown };
  assert.equal(env.t, "frame");
  assert.equal(env.p, "tiny");
  assert.equal(env.fc, undefined);
});

check("node chunks → node reassembles the exact payload", () => {
  const payload = "A".repeat(FRAME_CHUNK_BYTES * 2 + 123);
  const msgs = nFrameMessages(payload);
  assert.equal(msgs.length, 3); // ceil((2*chunk + 123)/chunk)
  const re = new FrameReassembler();
  let out: string | null = null;
  for (const m of msgs) out = re.accept(JSON.parse(m));
  assert.equal(out, payload);
});

check("node chunks → browser reassembles (and the reverse)", () => {
  const payload = "Z".repeat(FRAME_CHUNK_BYTES + 7);

  // node → browser
  const bReassemble = createFrameReassembler();
  let out: string | null = null;
  for (const m of nFrameMessages(payload)) out = bReassemble(JSON.parse(m));
  assert.equal(out, payload);

  // browser → node
  const nRe = new FrameReassembler();
  let out2: string | null = null;
  for (const m of bFrameMessages(payload)) out2 = nRe.accept(JSON.parse(m));
  assert.equal(out2, payload);
});

// ---------------------------------------------------------------------------
// 6. ReplayGuard: duplicate nonce and stale timestamp rejected, both stacks.
// ---------------------------------------------------------------------------
check("node ReplayGuard rejects duplicate nonce and stale frames", () => {
  const key = generateRoomKey();
  const guard = new ReplayGuard();
  const frame = openFrame(key, sealFrame(key, { n: 1 }));
  assert.equal(guard.accept(frame), true, "first sighting accepted");
  assert.equal(guard.accept(frame), false, "replayed identical frame rejected");
  assert.equal(guard.accept({ ts: Date.now() - 10 * 60_000, nonce: "fresh", data: 1 }), false, "stale frame rejected");
});

check("browser replay guard rejects duplicate nonce and stale frames", () => {
  const accept = createReplayGuard();
  const f = { ts: Date.now(), nonce: "abc123" };
  assert.equal(accept(f), true);
  assert.equal(accept(f), false, "duplicate nonce rejected");
  assert.equal(accept({ ts: Date.now() - 10 * 60_000, nonce: "def456" }), false, "stale frame rejected");
});

// ---------------------------------------------------------------------------
await Promise.all(pending);
if (failures > 0) {
  console.error(`\n${failures} crypto-conformance test(s) failed.`);
  process.exit(1);
}
console.log("\ncrypto-conformance tests passed.");
