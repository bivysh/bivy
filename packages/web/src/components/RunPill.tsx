// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// The in-session run badge. For a session an automation started (a labelled
// issue, a Slack request, a schedule, …) this supersedes the plain GithubPill
// in the band above the composer: it names the *source* and shows the run's
// live status, then opens the same action sheet — plus whatever GitHub links
// the session carries. For hand-opened sessions the band keeps the ordinary
// GithubPill, so this only ever appears where there's a real trigger to show.

import { useState } from "react";
import { primaryPr, type GithubContext, type PrRef } from "@bivy/core";
import { useModalEscape } from "../modalStack.js";
import { SourceGlyph } from "./SourceMark.js";
import { shortSourceLabel, type SourceInfo } from "../sessionSource.js";

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

export function RunPill({
  source,
  statusClass,
  statusLabel,
  gh,
}: {
  source: SourceInfo;
  /** The row's status class (`working` / `needs-action` / `saved` / `idle`)
   *  from sessionStatus.ts, shared with the sidebar so the two never drift. */
  statusClass: string;
  statusLabel: string;
  gh: GithubContext;
}) {
  const [open, setOpen] = useState(false);
  useModalEscape(() => setOpen(false), open);
  const actions = actionsFor(gh);
  // Lead the primary PR's state into the pill text when there is one — a merged
  // run reads "GitHub · Merged" rather than a generic "done".
  const pr = primaryPr(gh.prs);
  const short = shortSourceLabel(source.kind);

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
            {actions.length === 0 && (
              <div className="action-sheet-empty">This run carries no GitHub links yet.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
