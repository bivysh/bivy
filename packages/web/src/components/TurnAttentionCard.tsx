// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { Badge } from "./Badge.js";
import type { TurnAttentionRequest } from "@bivy/core";

/** A non-destructive watchdog decision. The turn is still alive while this card
 * is shown: Stop runs the normal recovery path; Keep waiting resets the stall
 * window and leaves the agent alone. */
export function TurnAttentionCard({
  attention,
  onResolve,
}: {
  attention: TurnAttentionRequest;
  onResolve: (sessionId: string, action: "stop" | "continue") => void;
}) {
  const [pending, setPending] = useState<"stop" | "continue" | null>(null);
  const resolve = (action: "stop" | "continue") => {
    setPending(action);
    onResolve(attention.sessionId, action);
  };

  return (
    <div id={`attention-${encodeURIComponent(attention.sessionId)}`} className="card question-card turn-attention-card" data-tone="warn" data-attention-card tabIndex={-1} role="alert">
      <div className="question-item">
        <div className="question-head"><Badge tone="warn" variant="soft" upper>Turn may be stuck</Badge></div>
        <div className="question-text">{attention.message}</div>
        <div className="question-option-desc">
          Bivy has not stopped the agent. The normal turn time limit is still active.
        </div>
      </div>
      <div className="approval-actions">
        <button className="btn danger-ghost" onClick={() => resolve("stop")} disabled={pending !== null}>
          {pending === "stop" ? "Stopping…" : "Stop turn"}
        </button>
        <button className="btn primary" onClick={() => resolve("continue")} disabled={pending !== null}>
          {pending === "continue" ? "Continuing…" : "Keep waiting"}
        </button>
      </div>
    </div>
  );
}
