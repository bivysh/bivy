// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// One-time pairing codes for devices that reach the node directly (over
// Tailscale). The owner mints a code on the machine (`bivy tailscale pair`),
// the phone opens `https://<machine>.ts.net/#pair=<code>` and trades the code
// for a device token. Codes are single-use, short-lived and held only in
// memory, so a restart invalidates every outstanding one.
import { createHash, randomBytes } from "node:crypto";

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const digest = (code: string) => createHash("sha256").update(code).digest("hex");

export class PairCodes {
  // Keyed by the code's hash, so a lookup never compares secrets directly.
  private readonly pending = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(ttlMs = PAIR_CODE_TTL_MS): { code: string; expiresAt: number } {
    this.sweep();
    const code = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.pending.set(digest(code), expiresAt);
    return { code, expiresAt };
  }

  /** True once per valid, unexpired code; the code is spent either way. */
  redeem(code: string): boolean {
    if (!code) return false;
    const key = digest(code);
    const expiresAt = this.pending.get(key);
    this.pending.delete(key);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.pending) if (expiresAt <= now) this.pending.delete(key);
  }
}
