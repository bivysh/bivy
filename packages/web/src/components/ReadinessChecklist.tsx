// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Setup checks and the confirmation that the user can send a message.

import type { Activation, ActivationCheckState, ActivationRemediationKind } from "@bivy/core";

const MARK: Record<ActivationCheckState, string> = {
  passed: "✓",
  failed: "!",
  checking: "…",
  pending: "·",
  unavailable: "–",
};

export function ReadinessChecklist({
  activation,
  onRemediate,
  onDismiss,
}: {
  activation: Activation;
  /** Handlers for the concrete next actions. A remediation button renders only
   *  when a handler exists for its kind — no inert buttons. */
  onRemediate?: Partial<Record<ActivationRemediationKind, () => void>>;
  onDismiss?: () => void;
}) {
  if (activation.activated) return (
    <section className="readiness" role="status" aria-label="Setup readiness">
      <div className="banner inline" data-tone="ok">You're all ready to send a message.</div>
    </section>
  );

  const next = activation.nextAction;
  const handler = next && onRemediate ? onRemediate[next.kind] : undefined;
  const passedCount = activation.checks.filter((check) => check.state === "passed").length;

  return (
    <section className="card readiness" role="status" aria-label="Setup readiness">
      <header className="readiness-head">
        <span className="readiness-title">Finish setting up</span>
        {onDismiss && (
          <button type="button" className="readiness-dismiss" onClick={onDismiss} aria-label="Dismiss readiness checklist">
            ×
          </button>
        )}
      </header>
      {passedCount > 0 && (
        <p className="readiness-passed">✓ {passedCount} setup {passedCount === 1 ? "check" : "checks"} complete</p>
      )}
      <ol className="readiness-checks">
        {activation.checks.map((check) => (
          <li key={check.id} className={`readiness-check state-${check.state}`}>
            <span className={`readiness-mark mark-${check.state}`} aria-hidden>{MARK[check.state]}</span>
            <span className="readiness-label">{check.label}</span>
            {check.detail && <span className="readiness-detail">{check.detail}</span>}
          </li>
        ))}
      </ol>
      {next && handler && (
        <button type="button" className="btn sm primary readiness-next" onClick={handler}>
          {next.label}
        </button>
      )}
    </section>
  );
}
