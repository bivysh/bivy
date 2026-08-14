// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Server-side session↔machine correlation for HOSTED-ORIGIN sessions (Gap 3).
//
// A device records a `session_correlation` row when IT launches an ephemeral, but
// a purely hosted-provisioned session (the control plane launched the machine with
// no device online) had none — so `planRestoreProvision` (ephemeral-provisioner.ts)
// couldn't find the reuse node to rebuild it after teardown. When a machine the CP
// provisioned (a `hosted_machines` record keyed by this nodeId) advertises a NEW
// session, mirror the device's write from the persisted launch config — without
// clobbering an existing (e.g. device-recorded) row. Best-effort: a correlation
// write must never fail a session advert. Isolated + store-injected so it's
// unit-testable without the server entrypoint.

import type { SessionCorrelation, SessionCorrelationInput } from "./store.js";

export interface HostedCorrelationStore {
  getHostedMachines(accountId: string): Promise<Array<Record<string, unknown>>>;
  getSessionCorrelation(accountId: string, sessionId: string): Promise<SessionCorrelation | undefined>;
  setSessionCorrelation(accountId: string, input: SessionCorrelationInput): Promise<SessionCorrelation>;
}

export async function correlateHostedSessions(
  store: HostedCorrelationStore,
  node: { accountId: string; id: string },
  sessions: Array<{ sessionId?: unknown }>,
): Promise<void> {
  if (sessions.length === 0) return;
  try {
    const machines = await store.getHostedMachines(node.accountId);
    const m = machines.find((x) => x.nodeId === node.id);
    if (!m || !m.provider) return; // not a hosted-provisioned machine (or no provider to record)
    for (const s of sessions) {
      const sessionId = String(s.sessionId ?? "");
      if (!sessionId) continue;
      if (await store.getSessionCorrelation(node.accountId, sessionId)) continue; // keep an existing row
      await store.setSessionCorrelation(node.accountId, {
        sessionId,
        nodeId: node.id,
        provider: String(m.provider),
        region: m.region != null ? String(m.region) : undefined,
        ttlMinutes: m.ttlMinutes != null ? Number(m.ttlMinutes) : undefined,
        repo: m.repo != null ? String(m.repo) : undefined,
        setupId: m.setupId != null ? String(m.setupId) : undefined,
        machineId: m.id != null ? String(m.id) : undefined,
        app: m.app != null ? String(m.app) : undefined,
      });
    }
  } catch {
    /* best-effort; a correlation write must never block a session advert */
  }
}
