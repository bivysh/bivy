// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { formatApproval, type ApprovalRequest } from "@bivy/core";

// How long the "pending" state is given before it's treated as stalled and a
// retry affordance appears. There's no protocol-level ack/timeout for a
// resolveApproval send — the card only leaves "pending" when the node
// broadcasts `approval.resolved`, which can never arrive (dropped message,
// node reconnect mid-flight, etc.), leaving no way out before this.
const STALL_MS = 8000;

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve: (id: string, approved: boolean) => void;
}) {
  // #217: the card stays visible after a click; only the server removing the
  // approval (approval.resolved) unmounts it. We show a pending state meanwhile.
  const [pending, setPending] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const f = formatApproval(approval);
  // Remembered so Retry can resend the exact same decision without the user
  // re-picking Approve/Reject.
  const lastChoice = useRef<{ approved: boolean } | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (stallTimer.current) clearTimeout(stallTimer.current); }, []);

  const armStallTimer = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => setStalled(true), STALL_MS);
  };

  const resolve = (approved: boolean) => {
    lastChoice.current = { approved };
    setPending(true);
    setStalled(false);
    onResolve(approval.id, approved);
    armStallTimer();
  };
  const retry = () => {
    if (!lastChoice.current) return;
    setStalled(false);
    onResolve(approval.id, lastChoice.current.approved);
    armStallTimer();
  };
  const badgeText = f.severity === "critical" ? "Permanent" : f.severity === "high" ? "High risk" : f.severity === "medium" ? "Medium risk" : "Low risk";
  return (
    <div className={`approval-card sev-${f.severity}${pending ? " pending" : ""}`}>
      <div className="approval-head">
        <span className="approval-title">{f.title}</span>
        <span className={`approval-badge tone-${f.severity}`}>{badgeText}</span>
      </div>
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
          Waiting for the node to apply your choice…
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
          <button className="btn danger-ghost" onClick={() => resolve(false)}>
            Reject
          </button>
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
  onResolve: (id: string, approved: boolean) => void;
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
