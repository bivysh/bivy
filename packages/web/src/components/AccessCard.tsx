// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// How the connected machine can be reached: the card in Settings → Machines,
// and the one-line nudge shown where a feature needs a setup this machine
// doesn't have yet. Both render the node's access report.
import { useEffect, useState } from "react";
import { controller } from "../store/useStore.js";
import { activeLabel, providersOf, type AccessFeatureId, type AccessReport } from "../access.js";
import { openSettings, setSettingsView } from "../settingsRoute.js";

const REACH_DETAIL = ["", "on your tailnet", "from anywhere"];

function useAccess(enabled = true): { report: AccessReport | null; error: string } {
  const [report, setReport] = useState<AccessReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    controller.getAccess()
      .then((next) => { if (live) setReport(next); })
      .catch((e) => { if (live) setError(String((e as Error)?.message || e)); });
    return () => { live = false; };
  }, [enabled]);
  return { report, error };
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="repo-connect-command">
      <code>{command}</code>
      <button
        type="button"
        className={`btn sm ghost${copied ? " is-copied" : ""}`}
        aria-label={`Copy ${command}`}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function AccessCard() {
  const { report, error } = useAccess();
  return (
    <section className="settings-section" aria-labelledby="access-title">
      <h4 className="settings-subhead" id="access-title">How you reach this machine</h4>
      {!report ? (
        <p className="muted small" role={error ? "alert" : "status"}>{error ? `Couldn't ask the machine: ${error}` : "Checking…"}</p>
      ) : (
        <>
          <div className="small"><strong>{activeLabel(report)}</strong>{report.tailscaleUrl ? <span className="muted"> · {report.tailscaleUrl}</span> : null}</div>
          <ul className="readiness-checks">
            {report.features.map((feature) => {
              const reach = report.reach[feature.id];
              return (
                <li key={feature.id} className={`readiness-check${reach ? "" : " state-pending"}`}>
                  <span className={`readiness-mark${reach ? " mark-passed" : ""}`} aria-hidden>{reach ? "✓" : "–"}</span>
                  <span className="readiness-label">{feature.label}</span>
                  <span className="readiness-detail" aria-hidden>{reach ? REACH_DETAIL[reach] : "not with this setup"}</span>
                  <span className="sr-only">{reach ? `: yes, ${REACH_DETAIL[reach]}` : ": not with this setup"}</span>
                </li>
              );
            })}
          </ul>
          {report.next.length > 0 && (
            <>
              <h4 className="settings-subhead">Next</h4>
              {report.next.map((step) => {
                const setup = report.setups.find((s) => s.id === step.id);
                if (!setup) return null;
                return (
                  <div key={step.id} className="settings-section">
                    <div className="small"><strong>{setup.label}</strong> <span className="muted">adds {step.addsText}. {setup.summary}</span></div>
                    {setup.command && <CopyCommand command={setup.command} />}
                  </div>
                );
              })}
              <div className="muted small">Run these on the machine. Setups stack: adding one never takes away another.</div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** "Push notifications need Bivy hosted or your own server", when this machine can't do `feature`. */
export function AccessNudge({ feature, inSettings = false }: { feature: AccessFeatureId; inSettings?: boolean }) {
  // Through the relay a machine always has push and sharing; only a directly
  // reached machine (Tailscale) can lack them, so only that one is asked.
  const { report } = useAccess(controller.direct);
  if (!report || report.reach[feature] > 0) return null;
  const label = report.features.find((f) => f.id === feature)?.label ?? feature;
  return (
    <div className="banner inline" data-tone="accent">
      <span className="banner-text" role="status">{label} need {providersOf(report, feature)}.</span>
      <span className="banner-actions">
        <button type="button" className="btn sm" onClick={() => (inSettings ? setSettingsView("nodes") : openSettings("nodes"))}>See options</button>
      </span>
    </div>
  );
}
