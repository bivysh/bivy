// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// End-to-end room crypto (AES-GCM) + replay guard.
// Ported from public/app/e2e.js. The packed layout (iv[12] | tag[16] | ct) must
// stay identical to the node peer's expectation — do not "improve" it.

import { b64, unb64 } from "./base64.js";
import { IV_BYTES, GCM_TAG_BYTES, SEALED_HEADER_BYTES, REPLAY_WINDOW_MS, MAX_SEEN_NONCES } from "./wire-format.js";

export type RoomKey = CryptoKey;

export async function importRoomKey(bytes: Uint8Array): Promise<RoomKey> {
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: RoomKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: GCM_TAG_BYTES * 8 }, key, new TextEncoder().encode(plaintext)),
  );
  const ct = out.slice(0, out.length - GCM_TAG_BYTES);
  const tag = out.slice(out.length - GCM_TAG_BYTES);
  const packed = new Uint8Array(SEALED_HEADER_BYTES + ct.length);
  packed.set(iv, 0);
  packed.set(tag, IV_BYTES);
  packed.set(ct, SEALED_HEADER_BYTES);
  return b64(packed);
}

export async function open(key: RoomKey, payload: string): Promise<string> {
  const buf = unb64(payload);
  const iv = buf.slice(0, IV_BYTES);
  const tag = buf.slice(IV_BYTES, SEALED_HEADER_BYTES);
  const ct = buf.slice(SEALED_HEADER_BYTES);
  const combined = new Uint8Array(ct.length + GCM_TAG_BYTES);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined));
}

export interface SealedFrame {
  ts: number;
  nonce: string;
  [k: string]: unknown;
}

export interface ReplayGuardOptions {
  replayWindowMs?: number;
  maxNonces?: number;
}

/** Rejects frames that are too old or whose nonce was already seen. */
export function createReplayGuard(opts?: ReplayGuardOptions): (frame: unknown) => boolean {
  const replayWindowMs = opts?.replayWindowMs || REPLAY_WINDOW_MS;
  const maxNonces = opts?.maxNonces || MAX_SEEN_NONCES;
  const seen = new Map<string, number>();
  return function acceptFrame(frame: unknown): boolean {
    const f = frame as SealedFrame | null;
    if (!f || typeof f.ts !== "number" || typeof f.nonce !== "string") return false;
    const now = Date.now();
    if (Math.abs(now - f.ts) > replayWindowMs) return false;
    if (seen.has(f.nonce)) return false;
    seen.set(f.nonce, now + replayWindowMs);
    if (seen.size > maxNonces) {
      for (const [n, exp] of seen) if (exp <= now) seen.delete(n);
    }
    return true;
  };
}
