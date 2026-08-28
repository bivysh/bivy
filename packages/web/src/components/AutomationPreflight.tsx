// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useState } from "react";
import { simulateAutomation, type AutomationPreflightSeverity, type AutomationSimulationDraft, type AutomationSimulationEvent, type AutomationSimulationResult } from "@bivy/core";
import { controller } from "../store/controller.js";

export function useAutomationPreflight(automationId: string | undefined) {
  const [result, setResult] = useState<AutomationSimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ack, setAck] = useState(false);

  const run = useCallback(async (
    draft: AutomationSimulationDraft,
    event?: AutomationSimulationEvent,
    opts?: { resetAck?: boolean },
  ) => {
    setBusy(true);
    setError("");
    try {
      const r = await simulateAutomation(controller.local, { automationId, draft, event });
      setResult(r);
      if (opts?.resetAck !== false) setAck(false);
      return r;
    } catch (e) {
      setResult(null);
      setError(String((e as Error).message || e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [automationId]);

  return { result, busy, error, ack, setAck, run };
}

function preflightIcon(severity: AutomationPreflightSeverity): string {
  if (severity === "ok") return "✓";
  if (severity === "block") return "✗";
  if (severity === "warn") return "⚠";
  if (severity === "skipped") return "·";
  return "ℹ";
}

export function AutomationPreflightPanel({
  result,
  error,
  ack,
  onAckChange,
  showTrail,
}: {
  result: AutomationSimulationResult | null;
  error: string;
  ack: boolean;
  onAckChange: (value: boolean) => void;
  showTrail: boolean;
}) {
  if (error) return <p className="settings-error">{error}</p>;
  if (!result) return null;
  const ownOverlaps = result.overlaps.filter((o) => o.beforeId === result.subjectId || o.afterId === result.subjectId);
  const visibleChecks = result.preflight.filter((c) => c.severity !== "skipped");
  return (
    <div className="autom-preflight" role="status">
      {showTrail && result.trail.length > 0 && (
        <div className="autom-preflight-trail">
          <div className="autom-field-label">Rule evaluation (first match wins)</div>
          <ul className="autom-preflight-list">
            {result.trail.map((t) => (
              <li key={t.id} className={t.matched ? "ok" : undefined}>
                <span>{t.matched ? "✓" : "·"}</span>{" "}
                {t.id === result.subjectId ? <strong>this automation</strong> : t.id}: {t.reason}
              </li>
            ))}
          </ul>
          {!result.matchedId && <p className="schedule-hint warn">No automation — including this one — would fire for this event.</p>}
        </div>
      )}
      {ownOverlaps.map((o, i) => (
        <p key={i} className={o.kind === "shadowed" ? "settings-error" : "schedule-hint warn"}>{o.detail}</p>
      ))}
      {visibleChecks.length > 0 && (
        <div className="autom-preflight-checks">
          <div className="autom-field-label">Preflight</div>
          <ul className="autom-preflight-list">
            {visibleChecks.map((c) => (
              <li key={c.id} className={`preflight-${c.severity}`}>
                <span>{preflightIcon(c.severity)}</span> <strong>{c.label}</strong>: {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.gate.blocked && (
        <p className="settings-error">
          Can&apos;t save yet — {result.gate.blockingChecks.map((c) => c.label).join(", ")}.
        </p>
      )}
      {!result.gate.blocked && result.gate.requiresAck && (
        <label className="autom-check-row">
          <input type="checkbox" checked={ack} onChange={(e) => onAckChange(e.target.checked)} />
          <span>I understand the warnings above and want to save anyway.</span>
        </label>
      )}
    </div>
  );
}
