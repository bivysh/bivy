// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  IV_BYTES,
  SEALED_HEADER_BYTES,
  FRAME_VERSION,
  FRAME_NONCE_BYTES,
  REPLAY_WINDOW_MS,
  MAX_SEEN_NONCES,
} from "./wire-format.js";

/**
 * End-to-end encryption envelope (AES-256-GCM).
 *
 * The 32-byte key is established during device pairing and shared only between
 * the node and its paired clients. The relay never has it, so it can route but
 * not read frames.
 *
 * Wire format (base64): [ 12-byte IV | 16-byte GCM tag | ciphertext ].
 */

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function open(key: Buffer, payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, SEALED_HEADER_BYTES);
  const ct = buf.subarray(SEALED_HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Anti-replay framing.
 *
 * GCM authenticates frame contents, so a compromised relay cannot forge or
 * tamper. It can, however, REPLAY a previously captured (still-valid) frame
 * verbatim. To stop that we wrap the payload with freshness metadata — a
 * timestamp and a random nonce — INSIDE the authenticated plaintext, and the
 * receiver rejects stale or already-seen frames (see ReplayGuard).
 *
 * Wrapped plaintext: { v: 1, ts: <ms>, nonce: <base64>, data: <payload> }.
 */
export interface Frame {
  ts: number;
  nonce: string;
  data: unknown;
}

export function sealFrame(key: Buffer, data: unknown): string {
  const frame = { v: FRAME_VERSION, ts: Date.now(), nonce: randomBytes(FRAME_NONCE_BYTES).toString("base64"), data };
  return seal(key, JSON.stringify(frame));
}

export function openFrame(key: Buffer, payload: string): Frame {
  const env = JSON.parse(open(key, payload)) as { ts?: unknown; nonce?: unknown; data?: unknown };
  if (!env || typeof env !== "object" || typeof env.ts !== "number" || typeof env.nonce !== "string") {
    throw new Error("Malformed frame");
  }
  return { ts: env.ts, nonce: env.nonce, data: env.data };
}

/**
 * Rejects stale (outside the freshness window) or duplicate (nonce already
 * seen) frames. A bounded seen-nonce cache handles multiple senders sharing the
 * key without per-sender sequence state.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>(); // nonce -> expiry (ms)

  constructor(private readonly windowMs = REPLAY_WINDOW_MS) {}

  /** Returns true if the frame is fresh and previously unseen. */
  accept(frame: Frame): boolean {
    const now = Date.now();
    if (Math.abs(now - frame.ts) > this.windowMs) return false;
    if (this.seen.has(frame.nonce)) return false;
    this.seen.set(frame.nonce, now + this.windowMs);
    if (this.seen.size > MAX_SEEN_NONCES) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
  }
}
