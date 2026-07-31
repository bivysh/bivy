// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// The in-session run card. It sits in the band above the composer for *every*
// active session and names the session's source — an automation trigger (a
// labelled issue, a Slack request, a schedule, …) or a plain hand-opened
// session — with its live status. Tapping it opens a sheet with whatever
// applies: the run's outcome (finished time, checks, attempts, routing/ruleset
// reason, branch/PR, the approval + sandbox policy it ran under — from the
// account queue's evidence record, see runEvidence.ts), GitHub links, the
// cost / token / plan-quota usage that used to live in the standalone bar under
// the topbar, and — when this session was forked from another one — its fork
// lineage. Non-automation sessions simply carry less to show (source, status,
// usage) — the card is the same, the information applies.

import { useState } from "react";
import { type GithubContext, type GithubQueueItem, type PrRef, type Usage } from "@bivy/core";
import { useModalEscape } from "../modalStack.js";
import { SourceGlyph } from "./SourceMark.js";
import { PrBadge, GhMark } from "./SessionList.js";
import { shortSourceLabel, type SourceInfo } from "../sessionSource.js";
import { checkCounts, retryReason, runDuration } from "../runEvidence.js";

interface Action {
  label: string;
  url: string;
  /** Render a GitHub mark on the right (the branch link). */
  github?: boolean;
}

/** " · resets Mar 4, 9:00 AM" for a plan window's reset instant, or "" if none. */
function formatResets(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ` · resets ${d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/** Human labels for the run's policy tiers (mirrors the automation editor's
 *  option text in Automations.tsx), with the raw tag as a safe fallback. */
const APPROVAL_LABEL: Record<string, string> = {
  autonomous: "Autonomous",
  risky: "Ask before risky actions",
  always: "Ask before every action",
  never: "Never ask",
};
const SANDBOX_LABEL: Record<string, string> = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};

/** "Jul 30, 3:04 PM" for an instant (epoch ms or ISO), or "" if unparseable. */
function formatWhen(value: number | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
    actions.push({ label: gh.branch, url: `https://github.com/${gh.repo}/tree/${encodeURIComponent(gh.branch)}`, github: true });
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
  finishedAt,
  usage,
  forkedFrom,
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
  /** Epoch ms the session's last turn finished (SessionSummary.finishedAt).
   *  Present for every session, not just automation runs — undefined for one
   *  that hasn't finished a turn yet. */
  finishedAt?: number;
  /** The session's cost / token / plan-quota snapshot, moved here from the
   *  standalone usage bar (null before the session reports any usage). */
  usage?: Usage | null;
  /** The parent this session was forked from, when it is a fork (see
   *  src/session/fork.ts on the node). `name` is resolved client-side from the
   *  local session list — the parent may live on another node or be gone by
   *  now, so it's best-effort and falls back to a shortened id. */
  forkedFrom?: { sessionId: string; name?: string };
}) {
  const [open, setOpen] = useState(false);
  useModalEscape(() => setOpen(false), open);
  const actions = actionsFor(gh);
  const short = shortSourceLabel(source.kind);

  const counts = evidence ? checkCounts(evidence) : null;
  const duration = evidence ? runDuration(evidence) : null;
  const finished = typeof finishedAt === "number" ? formatWhen(finishedAt) : "";
  const attempt = evidence?.attempt ?? 0;
  const reason = evidence ? retryReason(evidence) : null;
  const agentLine = [evidence?.runtimeId, evidence?.model].filter(Boolean).join(" · ");
  const failure = evidence?.output?.failure;
  const forkedFromLabel = forkedFrom ? forkedFrom.name || `session ${forkedFrom.sessionId.slice(0, 8)}` : null;

  const tokenTotal = usage?.tokens?.total ?? 0;
  const hasCost = typeof usage?.costUsd === "number";
  // Show the window nearest a limit first (highest utilization), matching the
  // old usage bar's "nearest window" pick.
  const planWindows = [...(usage?.plan?.windows ?? [])].sort(
    (a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0),
  );
  const hasUsage = hasCost || tokenTotal > 0 || planWindows.length > 0;

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
        <PrBadge prs={gh.prs} />
      </button>
      {open && (
        <div className="action-sheet open" role="dialog" aria-label={source.label}>
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
            </div>

            {failure && <div className="run-sheet-failure">{failure}</div>}

            {forkedFrom && (
              <div className="run-sheet-rows">
                <Row k="Forked from">{forkedFromLabel}</Row>
              </div>
            )}

            {(finished || duration) && (
              <div className="run-sheet-rows">
                <Row k="Finished">
                  {[finished || null, duration ? `ran ${duration}` : null].filter(Boolean).join(" · ")}
                </Row>
              </div>
            )}

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
                {evidence.routingReason && <Row k="Routing">{evidence.routingReason}</Row>}
                {evidence.output?.branch && (
                  <Row k="Branch"><code>{evidence.output.branch}</code></Row>
                )}
                {evidence.output?.commit && (
                  <Row k="Commit"><code>{evidence.output.commit.slice(0, 12)}</code></Row>
                )}
                {agentLine && <Row k="Ran on">{agentLine}</Row>}
                {evidence.approvalMode && (
                  <Row k="Approvals">{APPROVAL_LABEL[evidence.approvalMode] ?? evidence.approvalMode}</Row>
                )}
                {evidence.sandbox && (
                  <Row k="Sandbox">{SANDBOX_LABEL[evidence.sandbox] ?? evidence.sandbox}</Row>
                )}
              </div>
            )}

            {hasUsage && (
              <div className="run-sheet-rows">
                {hasCost && <Row k="Cost">${usage!.costUsd!.toFixed(4)}</Row>}
                {tokenTotal > 0 && <Row k="Tokens">{tokenTotal.toLocaleString()}</Row>}
                {planWindows.map((w) => (
                  <Row k={w.label} key={w.label}>
                    {typeof w.utilizationPct === "number" ? `${Math.round(w.utilizationPct)}% used` : "usage unknown"}
                    {formatResets(w.resetsAt)}
                  </Row>
                ))}
              </div>
            )}

            {actions.map((a) => (
              <a
                key={a.url}
                className={`action-sheet-item${a.github ? " gh-branch" : ""}`}
                href={a.url}
                target="_blank"
                rel="noopener"
                onClick={() => setOpen(false)}
              >
                <span>{a.label}</span>
                {a.github && <GhMark />}
              </a>
            ))}
            {evidence?.output?.artifactUrl && (
              <a className="action-sheet-item" href={evidence.output.artifactUrl} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
                View artifact
              </a>
            )}
            {actions.length === 0 && !evidence && !hasUsage && !forkedFrom && (
              <div className="action-sheet-empty">This session has nothing to report yet.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
