// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { formatApproval, type ApprovalRequest } from "@bivy/core";

// How long the "pending" state is given before it's treated as stalled and a
// retry affordance appears. There's no protocol-level ack/timeout for a
// resolveApproval send — the card only leaves "pending" when the node
// broadcasts `approval.resolved`, which can never arrive (dropped message,
// node reconnect mid-flight, etc.), leaving no way out before this.
const STALL_MS = 8000;

// The risk label above the title; only high and critical are colored.
const RISK: Record<ReturnType<typeof formatApproval>["severity"], { label: string; tone?: "danger" }> = {
  critical: { label: "Permanent", tone: "danger" },
  high: { label: "High risk", tone: "danger" },
  medium: { label: "Medium risk" },
  low: { label: "Low risk" },
};

/** What "Allow … this session" remembers, in words. A shell key is the
 *  program and subcommand (`npm test`) and reads best quoted; a tool key is the
 *  tool's name, which reads better as the kind of action it allows. */
const REMEMBER_LABEL: Record<string, string> = { edit: "file edits", write: "new files", multiedit: "file edits" };
const rememberLabel = (key: string) => REMEMBER_LABEL[key] ?? `“${key}”`;

export type ApprovalResolver = (id: string, approved: boolean, remember?: boolean) => void;

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve: ApprovalResolver;
}) {
  // #217: the card stays visible after a click; only the server removing the
  // approval (approval.resolved) unmounts it. We show a pending state meanwhile.
  const [pending, setPending] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const f = formatApproval(approval);
  // "Allow … for this session" is offered only when BOTH gates agree: the node
  // set `rememberKey` (a mode-driven ask, not a backstop prompt — see
  // src/policy/session-allow.ts) AND the client-side severity heuristic says
  // it's not a destructive/irreversible action (`canRemember`). Either side
  // alone can veto; neither can grant.
  const rememberKey = typeof approval.rememberKey === "string" && approval.rememberKey ? approval.rememberKey : null;
  const canRemember = f.canRemember && rememberKey !== null;
  // Remembered so Retry can resend the exact same decision without the user
  // re-picking Approve/Reject.
  const lastChoice = useRef<{ approved: boolean; remember: boolean } | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (stallTimer.current) clearTimeout(stallTimer.current); }, []);

  const armStallTimer = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => setStalled(true), STALL_MS);
  };

  const resolve = (approved: boolean, remember = false) => {
    lastChoice.current = { approved, remember };
    setPending(true);
    setStalled(false);
    onResolve(approval.id, approved, remember);
    armStallTimer();
  };
  const retry = () => {
    if (!lastChoice.current) return;
    setStalled(false);
    onResolve(approval.id, lastChoice.current.approved, lastChoice.current.remember);
    armStallTimer();
  };
  const risk = RISK[f.severity];
  return (
    <div id={`attention-${encodeURIComponent(approval.id)}`} className={`card approval-card sev-${f.severity}${pending ? " pending" : ""}`} data-tone={f.severity === "critical" ? "danger" : undefined} data-attention-card tabIndex={-1}>
      <div className="card-eyebrow" data-tone={risk.tone}>{risk.label}</div>
      <div className="approval-title">{f.title}</div>
      <div className="approval-consequence">{f.consequence}</div>
      {typeof approval.reason === "string" && approval.reason && <div className="approval-reason">{approval.reason}</div>}
      {f.command && <pre className="approval-command">{f.command}</pre>}
      {f.fields.length > 0 && (
        <div className="approval-fields">
          {f.fields.map(([label, value]) => (
            <div className="approval-field" key={label}>
              <div className="approval-field-label">{label}</div>
              <div className="approval-field-value">{value}</div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="approval-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? "Hide" : "Show"} raw tool input
      </button>
      {showRaw && <pre className="approval-summary">{f.rawInput}</pre>}
      {pending ? (
        <div className="approval-waiting">
          Waiting for the machine to apply your choice…
          {stalled && (
            <div className="approval-stalled">
              <span>This is taking longer than expected.</span>
              <button type="button" className="btn ghost" onClick={retry}>
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="approval-actions">
          <button className="btn ghost" onClick={() => resolve(false)}>
            Reject
          </button>
          {canRemember && (
            <button
              className="btn ghost"
              onClick={() => resolve(true, true)}
              title={`Approve, and allow ${rememberLabel(rememberKey!)} without asking until this session closes`}
            >
              Allow {rememberLabel(rememberKey!)} this session
            </button>
          )}
          <button className="btn primary" onClick={() => resolve(true)}>
            {f.severity === "critical" ? "Approve destructive action" : "Approve once"}
          </button>
        </div>
      )}
    </div>
  );
}

export function ApprovalStack({
  approvals,
  onResolve,
}: {
  approvals: ApprovalRequest[];
  onResolve: ApprovalResolver;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-stack">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} onResolve={onResolve} />
      ))}
    </div>
  );
}
