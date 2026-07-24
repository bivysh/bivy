// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { primaryPr, type GithubContext, type PrRef } from "@bivy/core";

// Ports the stranded GitHub UX (PRs #219 context menu + #220 status pill/action
// sheet) into the React client. Shows a pill for the active session's GitHub
// context; tapping it opens an action sheet with the relevant links. When a
// session has more than one PR (e.g. a first one merged and later work opened
// another), the pill shows the primary state and the sheet lists them all.

interface Action {
  label: string;
  url: string;
}

/** Human-facing label for a PR row in the action sheet. */
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

function GhIcon() {
  return (
    <svg className="gh-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GithubPill({ gh }: { gh: GithubContext }) {
  const [open, setOpen] = useState(false);
  const actions = actionsFor(gh);
  if (actions.length === 0) return null;

  // A PR (any state) wins the pill over an issue/branch — it's the most
  // actionable context and the one whose state (open/merged) the user tracks.
  const pr = primaryPr(gh.prs);
  const kind = pr ? "pr" : gh.issueUrl ? "issue" : "branch";
  const state = pr?.state ?? "";
  // For a branch pill on a repo-connected session, lead with the repo name so it
  // reads "repo · branch" — the repo is the context you're orienting on, the
  // branch the detail. `gh.repo` is "owner/name"; show just the short name.
  const repoShort = gh.repo ? gh.repo.split("/").pop() || gh.repo : null;
  const branchLabel = gh.branch
    ? repoShort
      ? `${repoShort} · ${gh.branch}`
      : gh.branch
    : "branch";
  const label = pr
    ? pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : "PR"
    : kind === "issue"
      ? "Issue"
      : branchLabel;

  return (
    <>
      <button className={`github-pill ${kind} ${state}`} onClick={() => setOpen(true)} title="GitHub context">
        <GhIcon />
        <span className="gh-text">{label}</span>
      </button>
      {open && (
        <div className="action-sheet open" role="dialog" aria-label="GitHub actions">
          <div className="action-sheet-backdrop" onClick={() => setOpen(false)} />
          <div className="action-sheet-body">
            <div className="action-sheet-head">
              <span>GitHub</span>
              <button className="action-sheet-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
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
          </div>
        </div>
      )}
    </>
  );
}
