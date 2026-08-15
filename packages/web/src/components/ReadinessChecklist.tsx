// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The activation readiness strip: the honest "are you actually ready?" checklist
// shown until a real agent has answered on the picked Machine. It renders the
// canonical Activation projection from @bivy/core — Machine online, agent
// installed, credential valid, repository ready, agent answered — and the single
// next action, so a customer always knows the one thing to do next.
//
// It NEVER shows a "ready" state: once activation.activated is true (a real
// agent response was observed) the strip renders nothing. That is the whole
// point — setup is never reported successful before the agent actually answers.

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
  // Ready means a real agent answered — nothing to prompt for.
  if (activation.activated) return null;

  const next = activation.nextAction;
  const handler = next && onRemediate ? onRemediate[next.kind] : undefined;

  return (
    <section className="card readiness" role="status" aria-label="Setup readiness">
      <header className="readiness-head">
        <span className="readiness-title">Get your first agent response</span>
        {onDismiss && (
          <button type="button" className="readiness-dismiss" onClick={onDismiss} aria-label="Dismiss readiness checklist">
            ×
          </button>
        )}
      </header>
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
        <button type="button" className="btn small primary readiness-next" onClick={handler}>
          {next.label}
        </button>
      )}
    </section>
  );
}
