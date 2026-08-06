// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Startup adoption policy (Stage 3 of docs/agent-node-decoupling.md).
 *
 * When a daemon (re)starts, its live handles are gone but the agent service kept
 * each session's child running (the "detach & keep running" disconnect policy).
 * The daemon enumerates the sessions it owns from the control plane
 * (`ControlPlaneSessionLocationRegistry.listNode`) and re-attaches to each still-
 * live one instead of losing it. This module is the transport-free DECISION core:
 * given the rows and an injected `attach`, it applies the failure policy and
 * reports what happened, so it unit-tests without a daemon or a socket (mirroring
 * backpressure.ts / session-event-coalescer.ts).
 *
 * Failure policy (product decision): distinguish a DEFINITIVELY-GONE session from
 * a merely-UNREACHABLE agent service.
 *  - Definitively gone (the service is reachable and reports no such detached
 *    session) → forget the mapping; the child really is gone, so a later resume
 *    should fall back to disk, not chase a dead address.
 *  - Transient (the service is unreachable — it may itself be restarting, racing
 *    the daemon restart) → KEEP the mapping and retry on the next access; forgetting
 *    here would orphan a child that is actually still alive.
 */

import type { SessionLocation } from "./session-location.js";

/**
 * The agent service's `attach` op replies "No detached session to attach: <id>"
 * (see agent-service.ts handleStart) when it is reachable but has no such live
 * session — the only DEFINITIVE "gone" signal. Every other failure (connection
 * refused / reset / closed-during-start / timeout) is transient: the service may
 * be down or restarting, so the child may well still exist.
 */
export function classifyAttachFailure(err: unknown): "gone" | "transient" {
  const message = err instanceof Error ? err.message : String(err);
  return /no detached session to attach/i.test(message) ? "gone" : "transient";
}

export interface AttachAdoptedDeps {
  /** Re-attach to one still-live session; MUST reject on any failure so the policy can classify it. */
  attach: (location: SessionLocation) => Promise<void>;
  /** Drop a mapping we've proven is definitively gone. */
  forget: (sessionId: string) => Promise<void>;
  /** Optional progress log. */
  log?: (message: string) => void;
}

export interface AdoptionOutcome {
  /** Re-attached to a still-live child. */
  adopted: string[];
  /** Service unreachable — mapping kept, will retry on next access. */
  kept: string[];
  /** Definitively gone — mapping forgotten. */
  forgotten: string[];
}

/**
 * Attempt to re-attach to each adoptable session concurrently, applying the
 * failure policy. Never throws — a single session's failure only affects its own
 * classification. Callers should PRE-RECORD every row's address into the durable
 * location registry BEFORE calling this, so a racing `advertiseSessions()` (the
 * replace-all-per-node POST) preserves the addresses even while attaches are still
 * in flight — otherwise the first advert would wipe the very column adoption reads.
 */
export async function attachAdoptedSessions(rows: SessionLocation[], deps: AttachAdoptedDeps): Promise<AdoptionOutcome> {
  const adopted: string[] = [];
  const kept: string[] = [];
  const forgotten: string[] = [];
  await Promise.all(
    rows.map(async (location) => {
      try {
        await deps.attach(location);
        adopted.push(location.sessionId);
        deps.log?.(`adopted ${location.sessionId} at ${location.agentServiceAddress}`);
      } catch (error) {
        if (classifyAttachFailure(error) === "gone") {
          forgotten.push(location.sessionId);
          await deps.forget(location.sessionId).catch(() => {});
          deps.log?.(`forgot definitively-gone session ${location.sessionId}`);
        } else {
          kept.push(location.sessionId);
          deps.log?.(`kept unreachable session ${location.sessionId} (${location.agentServiceAddress}) — will retry`);
        }
      }
    }),
  );
  return { adopted, kept, forgotten };
}
