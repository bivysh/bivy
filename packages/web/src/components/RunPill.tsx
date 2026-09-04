// SPDX-License-Identifier: AGPL-3.0-only
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
import { deriveRunOutcome, toolGroupSummary, type GithubContext, type GithubQueueItem, type PrRef, type ToolActivity, type Usage } from "@bivy/core";
import { SourceMark } from "./SourceMark.js";
import { StatusDot, type StatusDotState } from "./StatusDot.js";
import { Badge } from "./Badge.js";
import { Sheet } from "./Sheet.js";
import { PrBadge, GhMark } from "./SessionList.js";
import { shortSourceLabel, type SourceInfo } from "../sessionSource.js";
import { checkCounts, retryReason, runDuration, artifactRef, recoveryActions, type RecoveryKind } from "../runEvidence.js";
import { ToolActivitySheet } from "./ToolGroup.js";

const RECOVERY_LABEL: Record<RecoveryKind, string> = { fix: "Fix", retry: "Retry checks", fork: "Fork" };

interface Action {
  label: string;
  url: string;
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

// The sheet's GitHub links (issue / PR / branch) — one row anatomy, each led by
// the GitHub mark, so they read as one group. `gh.repo` is "owner/name"; lead
// the branch link with it so it reads "org/repo · branch" — the repo is the
// context, the branch the detail.
function actionsFor(gh: GithubContext): Action[] {
  const actions: Action[] = [];
  if (gh.issueUrl) actions.push({ label: "Open issue", url: gh.issueUrl });
  for (const pr of gh.prs) actions.push({ label: prActionLabel(pr), url: pr.url });
  if (gh.branch && gh.repo)
    actions.push({ label: `${gh.repo} · ${gh.branch}`, url: `https://github.com/${gh.repo}/tree/${encodeURIComponent(gh.branch)}` });
  return actions;
}

/** The run's checks as inline pass/fail/skip chips (e.g. tests ✓ · lint ✗). */
function Checks({ item }: { item: GithubQueueItem }) {
  const checks = item.checks ?? [];
  if (checks.length === 0) return null;
  return (
    <div className="run-sheet-checks">
      {checks.map((c, i) => (
        <Badge key={`${c.name}-${i}`} tone={c.status === "passed" ? "ok" : c.status === "failed" ? "danger" : undefined}>
          {c.name} {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"}
        </Badge>
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
  filesEdited,
  onOpenChanges,
  artifactsCount,
  onOpenArtifacts,
  onRecover,
  onOpenRun,
  anchorId,
  activity = [],
}: {
  source: SourceInfo;
  /** The row's status class (`working` / `needs-action` / `saved` / `idle`)
   *  from sessionStatus.ts, shared with the sidebar so the two never drift. */
  statusClass: Exclude<StatusDotState, "online" | "unseen">;
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
  /** Unique files touched this session (across turns). Shown on the pill and as
   *  a sheet row that opens the full changes view — replaces the bulky
   *  above-composer ChangesCard. */
  filesEdited?: number;
  /** Open the full session-changes sheet (diff tree, undo, review). */
  onOpenChanges?: () => void;
  /** Count of distinct artifacts (agent-sent attachments, user uploads,
   *  resolved inline images) this session's transcript carries — from
   *  deriveArtifacts(state.activeSession.transcript), computed in App. */
  artifactsCount?: number;
  /** Open the Artifacts sheet. */
  onOpenArtifacts?: () => void;
  /** Invoked when the user taps a recovery action on a terminal run (C2). The
   *  parent (App) maps each kind onto a real capability: fix → send a "fix the
   *  failing checks" prompt, retry → re-run the checks, fork → fork the session.
   *  Omitted where no session is in scope, hiding the buttons. */
  onRecover?: (kind: RecoveryKind) => void;
  /** Open the routable Run detail screen (/runs/:runId) for this session's Run.
   *  Wired only when the session has a correlated Run record (evidence.id). This
   *  is the Session → Run half of the correlation: a retry keeps the same Run id,
   *  so this always points at the one customer-visible Run. */
  onOpenRun?: (runId: string) => void;
  /** DOM id (`attention-<sessionId>`) so an outcome deep-link from the Inbox or a
   *  push tap scrolls to this pill — the exact outcome — not just the session (B3). */
  anchorId?: string;
  /** Durable mechanical work from the transcript. It is intentionally exposed
   * through this receipt rather than interrupting the conversation. */
  activity?: ToolActivity[];
}) {
  const [open, setOpen] = useState(false);
  const [workLogOpen, setWorkLogOpen] = useState(false);
  const actions = actionsFor(gh);
  const short = shortSourceLabel(source.kind);
  // The plain "Open" state means the session is still live on its node and can
  // be resumed instantly (the counterpart to "Saved" — no live record). Spell
  // that out in the sheet, where there's room; the terse pill/sidebar keep "Open".
  const sheetStatus = statusLabel === "Open" ? "Open on machine" : statusLabel;

  const outcome = evidence ? deriveRunOutcome(evidence) : null;
  const counts = evidence ? checkCounts(evidence) : null;
  const duration = evidence ? runDuration(evidence) : null;
  const finished = typeof finishedAt === "number" ? formatWhen(finishedAt) : "";
  const attempt = evidence?.attempt ?? 0;
  const reason = evidence ? retryReason(evidence) : null;
  const artifact = evidence ? artifactRef(evidence) : null;
  const recovery = evidence && onRecover ? recoveryActions(evidence) : [];
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

  const filesLabel = filesEdited && filesEdited > 0
    ? `${filesEdited} file${filesEdited === 1 ? "" : "s"} edited`
    : null;
  const artifactsLabel = artifactsCount && artifactsCount > 0
    ? `${artifactsCount} artifact${artifactsCount === 1 ? "" : "s"}`
    : null;
  const activityLabel = activity.length > 0
    ? `${activity.length} action${activity.length === 1 ? "" : "s"}`
    : null;

  return (
    <>
      <button
        id={anchorId}
        className={`run-pill src-${source.kind} ${statusClass}`}
        onClick={() => setOpen(true)}
        title={[source.label, statusLabel, filesLabel].filter(Boolean).join(" · ")}
      >
        <SourceMark kind={source.kind} size="sm" />
        <span className="run-pill-label">{short}</span>
        <span className="run-pill-stat"><StatusDot status={statusClass} />{statusLabel}</span>
        <PrBadge prs={gh.prs} />
        {filesLabel && <span className="run-pill-files">{filesLabel}</span>}
      </button>
      {open && (
        <Sheet
          variant="action"
          ariaLabel={source.label}
          title={<span className="run-sheet-title"><SourceMark kind={source.kind} size="sm" />{source.label}</span>}
          onClose={() => setOpen(false)}
          autoFocusSearch={false}
        >
            <div className="run-sheet-status">
              <StatusDot status={statusClass} />
              {sheetStatus}
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
                {outcome && <Row k="Outcome"><Badge tone={outcome.tone === "success" ? "ok" : outcome.tone === "warning" ? "warn" : outcome.tone === "danger" ? "danger" : undefined}>{outcome.label}</Badge></Row>}
                {artifact?.url && (
                  <Row k="Artifact">
                    <a href={artifact.url} target="_blank" rel="noopener">{artifact.label}</a>
                  </Row>
                )}
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

            {filesLabel && onOpenChanges && (
              <button
                type="button"
                className="sheet-action run-sheet-changes"
                onClick={() => { setOpen(false); onOpenChanges(); }}
              >
                <span className="run-sheet-changes-icon" aria-hidden>◈</span>
                <span>{filesLabel}</span>
                <span className="run-sheet-changes-hint">View diffs</span>
              </button>
            )}

            {activityLabel && (
              <button
                type="button"
                className="sheet-action run-sheet-changes"
                onClick={() => { setOpen(false); setWorkLogOpen(true); }}
              >
                <span className="run-sheet-changes-icon" aria-hidden>↳</span>
                <span>Work log</span>
                <span className="run-sheet-changes-hint">{activityLabel}</span>
              </button>
            )}

            {artifactsLabel && onOpenArtifacts && (
              <button
                type="button"
                className="sheet-action run-sheet-changes"
                onClick={() => { setOpen(false); onOpenArtifacts(); }}
              >
                <span className="run-sheet-changes-icon" aria-hidden>📎</span>
                <span>{artifactsLabel}</span>
                <span className="run-sheet-changes-hint">View artifacts</span>
              </button>
            )}

            {actions.map((a) => (
              <a
                key={a.url}
                className="sheet-action gh-link"
                href={a.url}
                target="_blank"
                rel="noopener"
                onClick={() => setOpen(false)}
              >
                <GhMark />
                <span>{a.label}</span>
              </a>
            ))}
            {evidence?.output?.artifactUrl && (
              <a className="sheet-action" href={evidence.output.artifactUrl} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
                View artifact
              </a>
            )}
            {evidence?.id && onOpenRun && (
              <button
                type="button"
                className="sheet-action run-sheet-open-run"
                onClick={() => { setOpen(false); onOpenRun(evidence.id); }}
              >
                <span aria-hidden>▸</span>
                <span>Run details</span>
              </button>
            )}
            {recovery.length > 0 && onRecover && (
              <div className="run-sheet-recovery" role="group" aria-label="Recover this run">
                {recovery.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`btn small recover-${kind}`}
                    onClick={() => { onRecover(kind); setOpen(false); }}
                  >
                    {RECOVERY_LABEL[kind]}
                  </button>
                ))}
              </div>
            )}
            {actions.length === 0 && !evidence && !hasUsage && !forkedFrom && !filesLabel && !activityLabel && (
              <div className="sheet-action-empty">This session has nothing to report yet.</div>
            )}
        </Sheet>
      )}
      {workLogOpen && (
        <ToolActivitySheet
          tools={activity}
          summary={toolGroupSummary(activity)}
          onClose={() => setWorkLogOpen(false)}
        />
      )}
    </>
  );
}
