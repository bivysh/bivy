// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { SessionLaunchCheckpointId, SessionLaunchProgress } from "@bivy/core";
import { Spinner } from "./Spinner.js";

const CHECKPOINTS: ReadonlyArray<{ id: SessionLaunchCheckpointId; label: string; skippedLabel?: string }> = [
  { id: "account", label: "Checking account and provider access" },
  { id: "capacity", label: "Reserving Bivy Cloud capacity" },
  { id: "machine", label: "Creating the isolated Machine" },
  { id: "service", label: "Starting the secure Bivy service" },
  { id: "credentials", label: "Loading encrypted credentials" },
  { id: "repository", label: "Preparing the repository", skippedLabel: "No repository selected" },
  { id: "agent", label: "Starting the agent and session" },
  { id: "message", label: "Delivering your first message" },
];

function elapsedLabel(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
}

export function SessionLaunchProgressView({
  progress,
  onSetupCredentials,
}: {
  progress: SessionLaunchProgress;
  onSetupCredentials?: () => void;
}) {
  const terminalAt = progress.firstResponseAt ?? progress.failedAt;
  const [now, setNow] = useState(() => terminalAt ?? Date.now());

  useEffect(() => {
    if (terminalAt) {
      setNow(terminalAt);
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [terminalAt]);

  const duration = elapsedLabel(progress.startedAt, terminalAt ?? now);
  const title = progress.firstResponseAt
    ? `Agent responded in ${duration}`
    : progress.failedAt
      ? `Startup failed after ${duration}`
      : `Starting Bivy Cloud · ${duration} elapsed`;

  return (
    <section className="session-launch-progress" aria-label="Bivy Cloud startup progress">
      <div className="session-launch-progress-title" aria-live="polite">{title}</div>
      <ol className="session-launch-checkpoints">
        {CHECKPOINTS.map(({ id, label, skippedLabel }) => {
          const checkpoint = progress.checkpoints[id];
          const state = checkpoint?.state ?? "waiting";
          const text = state === "skipped" && skippedLabel ? skippedLabel : label;
          return (
            <li key={id} className={`session-launch-checkpoint state-${state}`}>
              <span className="session-launch-checkpoint-mark" aria-hidden="true">
                {state === "done" ? "✓" : state === "failed" ? "!" : state === "skipped" ? "–" : state === "active" ? <Spinner size="xs" /> : "○"}
              </span>
              <span>
                <span className="session-launch-checkpoint-label">{text}</span>
                {state === "failed" && checkpoint?.error && <span className="session-launch-checkpoint-error">{checkpoint.error}</span>}
              </span>
              <span className="sr-only"> — {state}</span>
            </li>
          );
        })}
      </ol>
      {progress.checkpoints.account?.state === "failed" && onSetupCredentials && (
        <button type="button" className="btn primary session-launch-action" onClick={onSetupCredentials}>
          Set up model provider for Bivy Cloud
        </button>
      )}
    </section>
  );
}
