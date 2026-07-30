// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// The in-session run badge. For a session an automation started (a labelled
// issue, a Slack request, a schedule, …) this supersedes the plain GithubPill
// in the band above the composer: it names the *source* and shows the run's
// live status, then opens a sheet with the run's outcome — the checks it ran,
// how many attempts it took, how long it ran, its branch/PR — brought here from
// the account queue's evidence record (see runEvidence.ts) instead of buried in
// the GitHub Queue screen. For hand-opened sessions the band keeps the ordinary
// GithubPill, so this only ever appears where there's a real trigger to show.

import { useState } from "react";
import { primaryPr, type GithubContext, type GithubQueueItem, type PrRef } from "@bivy/core";
import { useModalEscape } from "../modalStack.js";
import { SourceGlyph } from "./SourceMark.js";
import { shortSourceLabel, type SourceInfo } from "../sessionSource.js";
import { checkCounts, retryReason, runDuration } from "../runEvidence.js";

interface Action {
  label: string;
  url: string;
}

function prActionLabel(pr: PrRef): string {
  const num = pr.number ? ` #${pr.number}` : "";
  const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open";
  return `Pull request${num} (${state})`;
}

function actionsFor(gh: GithubContext): Action[] {
  const actions: Action[] = [];
  if (gh.issueUrl) actions.push({ label: "Open issue on GitHub", url: gh.issueUrl });
  for (const pr of gh.prs) actions.push({ label: prActionLabel(pr), url: pr.url });
  if (gh.branch && gh.repo)
    actions.push({ label: `View branch ${gh.branch}`, url: `https://github.com/${gh.repo}/tree/${encodeURIComponent(gh.branch)}` });
  return actions;
}

/** The run's checks as inline pass/fail/skip chips (e.g. tests ✓ · lint ✗). */
function Checks({ item }: { item: GithubQueueItem }) {
  const checks = item.checks ?? [];
  if (checks.length === 0) return null;
  return (
    <div className="run-sheet-checks">
      {checks.map((c, i) => (
        <span key={`${c.name}-${i}`} className={`chk ${c.status}`}>
          {c.name} {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"}
        </span>
      ))}
    </div>
  );
}

/** One key/value line in the sheet — only rendered when it has a value. */
function Row({ k, children }: { k: string; children?: React.ReactNode }) {
  if (children == null || children === false || children === "") return null;
  return (
    <div className="run-sheet-row">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function RunPill({
  source,
  statusClass,
  statusLabel,
  gh,
  evidence,
}: {
  source: SourceInfo;
  /** The row's status class (`working` / `needs-action` / `saved` / `idle`)
   *  from sessionStatus.ts, shared with the sidebar so the two never drift. */
  statusClass: string;
  statusLabel: string;
  gh: GithubContext;
  /** The run's evidence, joined by session id in App (null in direct/local
   *  mode, or before the run reports anything). */
  evidence?: GithubQueueItem;
}) {
  const [open, setOpen] = useState(false);
  useModalEscape(() => setOpen(false), open);
  const actions = actionsFor(gh);
  const pr = primaryPr(gh.prs);
  const short = shortSourceLabel(source.kind);

  const counts = evidence ? checkCounts(evidence) : null;
  const duration = evidence ? runDuration(evidence) : null;
  const attempt = evidence?.attempt ?? 0;
  const reason = evidence ? retryReason(evidence) : null;
  const agentLine = [evidence?.runtimeId, evidence?.model].filter(Boolean).join(" · ");
  const failure = evidence?.output?.failure;

  return (
    <>
      <button
        className={`run-pill src-${source.kind} ${statusClass}`}
        onClick={() => setOpen(true)}
        title={`${source.label} · ${statusLabel}`}
      >
        <span className="run-pill-glyph"><SourceGlyph kind={source.kind} /></span>
        <span className="run-pill-label">{short}</span>
        <span className="run-pill-stat"><span className="run-dot" />{statusLabel}</span>
      </button>
      {open && (
        <div className="action-sheet open" role="dialog" aria-label="Automation run">
          <div className="action-sheet-backdrop" onClick={() => setOpen(false)} />
          <div className="action-sheet-body">
            <div className="action-sheet-head">
              <span className="run-sheet-title">
                <span className={`source-mark sm src-${source.kind}`} aria-hidden><SourceGlyph kind={source.kind} /></span>
                {source.label}
              </span>
              <button className="action-sheet-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="run-sheet-status">
              <span className={`run-dot ${statusClass}`} aria-hidden />
              {statusLabel}
              {pr && <span className={`session-pr ${pr.state}`} aria-hidden><span className="session-pr-text">{pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : "Open PR"}</span></span>}
            </div>

            {failure && <div className="run-sheet-failure">{failure}</div>}

            {evidence && (
              <div className="run-sheet-rows">
                {counts && (
                  <Row k="Checks">
                    <Checks item={evidence} />
                  </Row>
                )}
                {attempt > 1 && (
                  <Row k="Attempts">{reason ? `${attempt} · ${reason}` : String(attempt)}</Row>
                )}
                {duration && <Row k="Ran for">{duration}</Row>}
                {evidence.output?.branch && (
                  <Row k="Branch"><code>{evidence.output.branch}</code></Row>
                )}
                {evidence.output?.commit && (
                  <Row k="Commit"><code>{evidence.output.commit.slice(0, 12)}</code></Row>
                )}
                {agentLine && <Row k="Ran on">{agentLine}</Row>}
              </div>
            )}

            {actions.map((a) => (
              <a
                key={a.url}
                className="action-sheet-item"
                href={a.url}
                target="_blank"
                rel="noopener"
                onClick={() => setOpen(false)}
              >
                {a.label}
              </a>
            ))}
            {evidence?.output?.artifactUrl && (
              <a className="action-sheet-item" href={evidence.output.artifactUrl} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
                View artifact
              </a>
            )}
            {actions.length === 0 && !evidence && (
              <div className="action-sheet-empty">This run carries no report yet.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
