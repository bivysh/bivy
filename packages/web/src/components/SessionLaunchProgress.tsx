// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { ModelInfo, SessionLaunchCheckpointId, SessionLaunchProgress } from "@bivy/core";
import { Spinner } from "./Spinner.js";
import { LaunchModelChoice } from "./LaunchModelChoice.js";

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
  onRetryLaunch,
  onRetryFreshMachine,
  onChooseModel,
  onRefreshModels,
}: {
  progress: SessionLaunchProgress;
  onChooseModel?: (model: ModelInfo) => Promise<void>;
  onRefreshModels?: () => void;
  onSetupCredentials?: () => Promise<void>;
  onRetryLaunch?: () => Promise<void>;
  onRetryFreshMachine?: () => Promise<void>;
}) {
  const choice = progress.modelChoice;
  const needsCredentials = progress.checkpoints.account?.errorCode === "managed_credentials_required";
  const retry = progress.checkpoints.machine?.state === "done" ? onRetryFreshMachine : onRetryLaunch;
  const retryLabel = progress.checkpoints.machine?.state === "done" ? "Retry on a new Cloud Machine" : "Retry this launch";
  const terminalAt = progress.firstResponseAt ?? progress.failedAt;
  const [now, setNow] = useState(() => terminalAt ?? Date.now());
  const [startingSetup, setStartingSetup] = useState(false);

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
      : choice ? choice.loading ? "Loading models from this machine" : choice.selecting ? "Confirming model selection" : "Choose a model before your first message"
      : progress.checkpoints.message?.state === "done"
        ? `Waiting for agent response · ${duration} elapsed`
        : `Starting Bivy Cloud · ${duration} elapsed`;

  return (
    <section className="session-launch-progress" aria-label="Bivy Cloud startup progress">
      <div className="session-launch-progress-title" aria-live="polite">{title}</div>
      {choice && <LaunchModelChoice choice={choice} onChoose={onChooseModel} onRefresh={onRefreshModels} onSetupCredentials={onSetupCredentials} />}
      <ol className="session-launch-checkpoints">
        {CHECKPOINTS.map(({ id, label, skippedLabel }) => {
          const checkpoint = progress.checkpoints[id];
          const state = progress.failedAt && checkpoint?.state === "active" ? "waiting" : checkpoint?.state ?? "waiting";
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
      {progress.failedAt && needsCredentials && onSetupCredentials && (
        <button
          type="button"
          className="btn primary session-launch-action"
          disabled={startingSetup}
          onClick={() => {
            setStartingSetup(true);
            void onSetupCredentials().finally(() => setStartingSetup(false));
          }}
        >
          {startingSetup ? "Opening setup…" : "Set up model credentials"}
        </button>
      )}
      {progress.failedAt && !needsCredentials && retry && (
        <button
          type="button"
          className="btn primary session-launch-action"
          disabled={startingSetup}
          onClick={() => {
            setStartingSetup(true);
            void retry().finally(() => setStartingSetup(false));
          }}
        >
          {startingSetup ? "Retrying…" : retryLabel}
        </button>
      )}
    </section>
  );
}
