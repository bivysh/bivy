// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// SINGLE SOURCE OF TRUTH for the Bivy E2E wire format.
//
// Bivy carries two byte-compatible crypto implementations — one on the node
// (node:crypto: src/e2e.ts + src/pairing-crypto.ts + src/relay-chunk.ts) and one
// in the browser/PWA client (WebCrypto: packages/core/src/crypto.ts + pairing.ts
// + relay-frame.ts). They MUST agree byte-for-byte or a phone can no longer read
// a node's frames (and vice versa). Historically the magic numbers and HKDF info
// strings were copied by hand into each file, which is exactly where the two
// halves silently drift.
//
// This module holds those shared constants ONCE. It is deliberately dependency-
// free and uses NO node- or browser-specific APIs (only plain strings/numbers),
// so both build roots can import it: the browser files import it directly
// (`./wire-format.js`), and the node re-exports it through `src/wire-format.ts`.
//
// Do NOT change any value here without changing the wire format — every constant
// below is observable on the wire and must match a paired peer.
//
// See test/crypto-conformance.test.ts for the conformance test that pins the
// node and browser implementations to these constants.

/**
 * HKDF `info` strings that domain-separate the per-device ECDH wrap keys. Both
 * ends must derive with the identical string or the room key fails to unwrap.
 */
export const HKDF_INFO = {
  /** Initial pairing (pair.hello → pair.welcome). */
  pair: "bivy-pair-v1",
  /** Room-key rotation after a device revoke. */
  rotate: "bivy-rotate-v1",
  /** Model-auth vault delivery (node-only today). */
  modelAuthVault: "bivy-model-auth-vault-v1",
  /** GitHub App private-key vault delivery (node-only, opt-in — issue #88). */
  githubAppVault: "bivy-github-app-vault-v1",
  /** Device→device ephemeral-provider-token vault delivery (opt-in). Unlike the
   *  node vaults above, the recipients are the account's paired DEVICES, so a
   *  second device can wake/reach a machine the first launched. */
  deviceVault: "bivy-device-vault-v1",
} as const;

/** Version byte stamped into every sealed frame's authenticated plaintext. */
export const FRAME_VERSION = 1;

/** AES-256-GCM room key length, in bytes. */
export const ROOM_KEY_BYTES = 32;

/** Length of the derived ECDH wrap key (HKDF output), in bytes. */
export const WRAP_KEY_BYTES = 32;

/** Length of the out-of-band pairing secret carried in the QR, in bytes. */
export const PAIR_SECRET_BYTES = 32;

/**
 * Packed sealed-envelope layout: [ IV | GCM tag | ciphertext ], base64.
 * The receiver slices by these fixed offsets, so they are wire-observable.
 */
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
/** Offset where ciphertext begins (= IV_BYTES + GCM_TAG_BYTES). */
export const SEALED_HEADER_BYTES = IV_BYTES + GCM_TAG_BYTES; // 28

/** Random freshness nonce embedded in each frame's authenticated plaintext. */
export const FRAME_NONCE_BYTES = 12;

/**
 * ReplayGuard freshness window and bounded seen-nonce cache size. Frames older
 * than the window (either direction) or with an already-seen nonce are dropped.
 */
export const REPLAY_WINDOW_MS = 5 * 60_000;
export const MAX_SEEN_NONCES = 5000;

/**
 * Relay frame chunking. The relay caps each WebSocket message at
 * RELAY_MAX_FRAME_BYTES (256 KiB default); larger sealed payloads are split into
 * ordered slices of at most FRAME_CHUNK_BYTES and reassembled before decrypting.
 * Kept comfortably below the relay cap so the JSON envelope still fits.
 */
export const FRAME_CHUNK_BYTES = 192 * 1024;

/** Reassembly safety caps — defend against a buggy/hostile peer. */
export const MAX_REASSEMBLY_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_CHUNKS = 4096;
export const MAX_REASSEMBLY_GROUPS = 16;
