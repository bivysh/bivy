// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Command/event protocol versioning (platform modularization Phase 2 — the
// "formalize the contract" slice; see docs/internal/platform-modularization-plan.md).
//
// The command/event surface is becoming the public API behind every client
// (CLI, PWA, TUI, SDK), so peers must be able to evolve without silently
// breaking one another. This module owns the version scalar and the
// compatibility policy; it is a pure leaf (no imports) so any transport can use
// it and it is trivially testable.

/** The wire protocol version this node speaks. Bump when the command/event
 *  surface changes in a way clients must be able to detect. */
export const PROTOCOL_VERSION = 1;

/** Peers that predate version negotiation present as v0 (today's surface). */
export const LEGACY_PROTOCOL_VERSION = 0;

/** An operation (command or event) tagged with the protocol version it was
 *  introduced at. `since: 0` means "has always existed" (the legacy surface). */
export interface VersionedOp {
  since: number;
}

/**
 * Compatibility policy: **serve a compatible subset** (decided 2026-08-11).
 *
 * A newer node does not reject an older client; it serves exactly the
 * operations introduced at or before the client's negotiated version, and
 * withholds newer ones. Legacy (unversioned) clients negotiate to v0 and are
 * served every op with `since <= 0` — i.e. today's surface, unchanged.
 */
export function isServedTo(op: VersionedOp, clientVersion: number): boolean {
  return op.since <= clientVersion;
}

/**
 * Meet the client where it is. The node speaks up to `PROTOCOL_VERSION`, so the
 * negotiated version is the client's request clamped to [LEGACY, PROTOCOL].
 * A missing/invalid/negative request negotiates to legacy (v0) rather than
 * failing — consistent with the compatible-subset policy.
 */
export function negotiateVersion(clientVersion: number | undefined): number {
  if (typeof clientVersion !== "number" || !Number.isFinite(clientVersion)) {
    return LEGACY_PROTOCOL_VERSION;
  }
  const requested = Math.trunc(clientVersion);
  if (requested <= LEGACY_PROTOCOL_VERSION) return LEGACY_PROTOCOL_VERSION;
  return Math.min(requested, PROTOCOL_VERSION);
}

/** Filter a set of versioned operations to the subset a client is served. */
export function compatibleSubset<T extends VersionedOp>(ops: Iterable<[string, T]>, clientVersion: number): Map<string, T> {
  const out = new Map<string, T>();
  for (const [kind, op] of ops) {
    if (isServedTo(op, clientVersion)) out.set(kind, op);
  }
  return out;
}
