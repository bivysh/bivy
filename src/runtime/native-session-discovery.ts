// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Capability-driven discovery/adoption of provider-native sessions (issue #156).
//
// This module is deliberately runtime-agnostic and side-effect-free: it never
// touches a filesystem or spawns a process itself — that stays inside each
// runtime's own `discoverNativeSessions()` (src/runtime/codex-sessions.ts,
// src/runtime/claude-code.ts). What lives here is the shared policy every
// runtime shares: aggregate discoveries across capable runtimes, drop ones
// Bivy already manages, and decide how an adoption should proceed. Pure logic
// is easy to test with fake runtimes and fixtures, which is exactly what issue
// #156 asks for ("tests use provider fixtures for path discovery, dedupe,
// resume, non-default homes, and unsupported runtimes").

import { sessionIdentityKey } from "../session-identity.js";
import type { AgentRuntime, DiscoveredNativeSession, RuntimeCapabilities } from "./types.js";

/** The minimal shape of a runtime needed to collect discoveries — a subset of
 *  AgentRuntime so tests can pass a fake without building a whole adapter. */
export interface DiscoverableRuntime {
  readonly id: string;
  readonly capabilities: Pick<RuntimeCapabilities, "nativeSessionDiscovery">;
  discoverNativeSessions?: AgentRuntime["discoverNativeSessions"];
}

/** A session Bivy already knows about, for cross-checking discoveries. Mirrors
 *  the {id, path} shape `listAllSessions()` (src/server.ts) already produces. */
export interface ManagedSessionRef {
  id: string;
  path?: string;
}

/** Build the set of identity keys for every session Bivy already manages, in
 *  the same `ref:<path>` / `id:<id>` scheme session-identity.ts uses — so a
 *  discovered session that resolves to the same durable conversation (whether
 *  by on-disk path or by provider session id) is recognized as already-managed
 *  regardless of which runtime variant (e.g. `codex` vs `codex-approvals`)
 *  originally opened it. */
function managedIdentityKeys(managed: ManagedSessionRef[]): Set<string> {
  const keys = new Set<string>();
  for (const session of managed) {
    keys.add(sessionIdentityKey({ id: session.id }));
    if (session.path) keys.add(sessionIdentityKey({ path: session.path }));
  }
  return keys;
}

/** True when `session` resolves to a conversation Bivy already manages —
 *  either by its provider ref (an id-based runtime's resume token) or by its
 *  on-disk transcript path, when known. */
export function isAlreadyManaged(session: Pick<DiscoveredNativeSession, "ref" | "file">, managedKeys: Set<string>): boolean {
  if (managedKeys.has(sessionIdentityKey({ id: session.ref }))) return true;
  if (session.file && managedKeys.has(sessionIdentityKey({ path: session.file }))) return true;
  return false;
}

/**
 * Collect discoverable sessions across every capable runtime, deduped against
 * Bivy-managed sessions AND against each other (two runtime variants over the
 * same provider store — e.g. `codex` exec vs `codex-approvals` — must not
 * surface the same on-disk session twice). Best-effort per runtime: one
 * adapter's discovery failing (a missing/unreadable store) never blanks the
 * whole list, mirroring listAllSessions()'s "best effort per agent" contract.
 * Sorted newest-first.
 */
export async function collectDiscoveredSessions(
  runtimes: DiscoverableRuntime[],
  managed: ManagedSessionRef[],
): Promise<DiscoveredNativeSession[]> {
  const managedKeys = managedIdentityKeys(managed);
  const seen = new Set<string>();
  const out: DiscoveredNativeSession[] = [];
  for (const runtime of runtimes) {
    if (!runtime.capabilities.nativeSessionDiscovery || !runtime.discoverNativeSessions) continue;
    let discovered: DiscoveredNativeSession[];
    try {
      discovered = (await runtime.discoverNativeSessions()) ?? [];
    } catch {
      continue; // best-effort: a broken adapter shouldn't blank every other one
    }
    for (const session of discovered) {
      if (isAlreadyManaged(session, managedKeys)) continue;
      // Cross-runtime value dedupe (same on-disk session surfaced by two
      // runtime variants): key on the transcript path when known, else the ref.
      const valueKey = session.file ? `file:${session.file}` : `ref:${session.runtimeId}:${session.ref}`;
      if (seen.has(valueKey)) continue;
      seen.add(valueKey);
      out.push(session);
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export type NativeAdoptionMode = "native-resume" | "seeded" | "follow-only";

export interface NativeAdoptionPlan {
  mode: NativeAdoptionMode;
  /** User-facing disclosure text, required whenever the adoption is not a
   *  transparent native resume (issue #156: "fall back to a seeded
   *  continuation only with explicit user disclosure"). */
  disclosure?: string;
}

/**
 * Decide how importing `session` should proceed, given the OWNING runtime's
 * capabilities. Three outcomes:
 *  - "follow-only": a live external process was detected. Bivy has no channel
 *    to safely take over an arbitrary foreign process, so adoption is refused
 *    and only read-only following (readMessages) is offered.
 *  - "native-resume": the runtime can adopt this session with full native
 *    context (capabilities.nativeSessionAdoption + resume + session.resumable).
 *  - "seeded": adoption is possible but not a true resume — a fresh session
 *    seeded from a summary of the prior conversation. Always carries a
 *    disclosure the caller must show before importing.
 */
export function planNativeAdoption(
  session: Pick<DiscoveredNativeSession, "active" | "resumable">,
  capabilities: Pick<RuntimeCapabilities, "resume" | "nativeSessionAdoption">,
): NativeAdoptionPlan {
  if (session.active) {
    return {
      mode: "follow-only",
      disclosure: "This session has a live process running outside Bivy. Close it in its own terminal, then adopt it here — or follow it read-only without adopting.",
    };
  }
  if (capabilities.nativeSessionAdoption && capabilities.resume && session.resumable) {
    return { mode: "native-resume" };
  }
  return {
    mode: "seeded",
    disclosure: "Native resume isn't available for this session. Importing starts a new Bivy session seeded with a summary of the prior conversation; the original session is left untouched.",
  };
}
