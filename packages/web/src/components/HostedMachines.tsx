// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Durable ephemeral lifecycle status for control-plane-launched (hosted)
// runners — the PWA surface for the durable attempt record: phase, TTL/
// deadline, snapshot state, and last error, plus a safe force-destroy that
// sets desiredState "deleted" and lets the reconciler retry until the
// provider confirms the resource is actually gone (see
// docs/ephemeral-lifecycle-review.md).
import { useEffect, useState } from "react";
import { ephemeralCatalogEntry, ephemeralLifecyclePhase, type HostedMachineSummary } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { ConfirmDialog } from "./AppDialog.js";

const PHASE_LABEL: Record<string, string> = {
  requested: "Requesting…",
  enrolled: "Enrolling…",
  "provider-accepted": "Booting…",
  tracked: "Booting…",
  ready: "Ready",
  claimed: "Claimed",
  working: "Working",
  deleting: "Tearing down…",
  deleted: "Deleted",
  failed: "Failed",
};

/** Prefer the durable attempt phase (server-driven, exact) when present; fall
 * back to the milestone-derived heuristic for older records with no attempt. */
function phaseLabel(m: HostedMachineSummary): string {
  if (m.desiredState === "deleted" && m.lifecycleState !== "deleted") return "Tearing down…";
  const known = m.lifecycleState ? PHASE_LABEL[m.lifecycleState] : undefined;
  if (known) return known;
  return ephemeralLifecyclePhase(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { milestones: m.milestones as any, purpose: m.purpose, claimedAt: m.claimedAt },
    Boolean(m.lastError),
  );
}

function phaseTone(phase: string, hasError: boolean): "ok" | "warn" | "err" {
  if (hasError || phase === "Failed" || phase === "teardown-failed") return "err";
  if (phase === "Tearing down…" || phase === "Requesting…" || phase === "Enrolling…" || phase === "Booting…") return "warn";
  return "ok";
}

/** Human-relative time until a deadline, or null when there isn't one /
 * it can't be parsed. Deliberately coarse (minutes/hours) — this is a status
 * hint, not a countdown timer. */
function relativeDeadline(iso: string | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "any moment";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export function HostedMachinesPanel() {
  const [machines, setMachines] = useState<HostedMachineSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<HostedMachineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => controller.listHostedMachines().then(setMachines).catch(() => setMachines((current) => current ?? []));
  useEffect(() => {
    refresh();
    // Poll rather than push: this panel only matters while a hosted machine
    // is actually alive (rare, unattended-execution accounts), and the fast
    // reconciler already converges within ~60s server-side.
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!machines || machines.length === 0) return null;

  const destroy = async (nodeId: string) => {
    setBusyId(nodeId);
    setError(null);
    try {
      await controller.destroyHostedMachine(nodeId);
    } catch (e) {
      // A failed synchronous destroy is not a lost cause: the server already
      // recorded desiredState "deleted" for this attempt before attempting
      // the provider call, so the reconciler keeps retrying it regardless of
      // this request's outcome — surface the error, don't imply it's stuck.
      setError(String((e as Error).message || e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  return (
    <section className="autom-section">
      <h2 className="autom-section-label">Hosted machines</h2>
      <p className="settings-hint">Control-plane-launched runners for unattended work — phase, TTL, and teardown status.</p>
      <div className="picker-list">
        {machines.map((m) => {
          const catalog = ephemeralCatalogEntry(m.provider);
          const phase = phaseLabel(m);
          const tone = phaseTone(phase, Boolean(m.lastError));
          const deadline = relativeDeadline(m.deadlineAt, Date.now());
          const snapshotReady = Boolean(m.milestones?.snapshotReadyAt);
          const key = m.nodeId || m.id;
          return (
            <div className="automation-row" key={key}>
              <div className="automation-row-main">
                <div className="automation-row-title">
                  <strong>{m.name || catalog?.name || m.provider}</strong>
                  <span className={`chip ${tone}`}>{phase}</span>
                </div>
                <div className="settings-hint">
                  {[
                    catalog?.name ?? m.provider,
                    m.region,
                    deadline ? `next deadline ~${deadline}` : null,
                    snapshotReady ? "snapshot ready" : null,
                  ].filter(Boolean).join(" · ")}
                </div>
                {m.lastError && <div className="settings-hint warn-text">{m.lastError}</div>}
              </div>
              <div className="automation-row-actions">
                {m.nodeId && (
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={busyId === m.nodeId || m.desiredState === "deleted"}
                    onClick={() => setConfirmTarget(m)}
                  >
                    {m.desiredState === "deleted" ? "Tearing down…" : busyId === m.nodeId ? "…" : "Force destroy"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="settings-hint warn-text">{error}</p>}
      {confirmTarget && (
        <ConfirmDialog
          title="Force destroy this machine?"
          message="This immediately asks the provider to delete it. If that request fails, the record stays visible and the reconciler keeps retrying automatically until deletion is confirmed — it never silently disappears while it might still be billing."
          confirmLabel="Force destroy"
          danger
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const nodeId = confirmTarget.nodeId!;
            setConfirmTarget(null);
            void destroy(nodeId);
          }}
        />
      )}
    </section>
  );
}
