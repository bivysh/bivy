// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { githubIssueRefFromSource, primaryPr, repoFromSource, type GithubQueueItem, type PrRef, type RunTerminalSummary } from "@bivy/core";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { ConfirmDialog, RenameDialog } from "./AppDialog.js";
import { attentionRank, isUnseen, statusClass, statusLabel } from "../sessionStatus.js";
import { SourceGlyph } from "./SourceMark.js";
import { classifySource, CLI_SOURCE, type SourceKind } from "../sessionSource.js";
import { rowHint } from "../runEvidence.js";

/** The leading indicator on a session row: a tinted source tile carrying the
 *  trigger's glyph, with the live status as a small dot badge on its corner.
 *  Source is the identity, status is the presence — one element, two axes, so
 *  the row now reads "where it came from" and "what it's doing" at a glance.
 *  The dot's colour/shape logic is the same statusClass the header pill uses. */
export function RowMark({ kind, status, unseen, srLabel }: { kind: SourceKind; status: string; unseen?: boolean; srLabel: string }) {
  return (
    <>
      <span className={`session-mark src-${kind}`} aria-hidden>
        <SourceGlyph kind={kind} />
        <span className={`mark-badge ${status}${unseen ? " unseen" : ""}`} />
      </span>
      {/* The mark + badge are colour/shape only and aria-hidden; mirror both the
          source and the status as screen-reader-only text (parity with the old
          bare status dot, which did the same for status alone). */}
      <span className="sr-only">{srLabel}</span>
    </>
  );
}

// How long "Update GitHub status" stays in its busy state before giving up and
// re-enabling the button — `controller.refreshPrStatus` is fire-and-forget
// (there's no direct response, only the async `session.pr_result` event), so
// without a cap a node that never replies would leave the button disabled
// forever.
const PR_BUSY_TIMEOUT_MS = 20000;

// Exported for reuse by GithubQueue.tsx, which renders the same row anatomy
// (status dot, PR badge, relative age) for the sessions the GitHub-app queue
// spawned — kept here instead of duplicated so the two lists can't drift.
export function GhMark() {
  return (
    <svg className="gh-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Compact PR status badge for a sidebar row — mirrors the header pill's state
 *  colours. Shows the primary PR (open wins, else most recent); a count suffix
 *  when a session carries more than one. Non-interactive (the row is a button). */
export function PrBadge({ prs }: { prs?: PrRef[] }) {
  const pr = primaryPr(prs);
  if (!pr) return null;
  const label = pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : "PR";
  const count = prs && prs.length > 1 ? prs.length : 0;
  return (
    <span className={`session-pr ${pr.state}`} title={count ? `${label} · ${count} pull requests` : label} aria-hidden>
      <GhMark />
      <span className="session-pr-text">{count ? `${label} ${count}` : label}</span>
    </span>
  );
}

/** Human-facing label for a PR link in a row's action sheet. */
function prActionLabel(pr: PrRef): string {
  const num = pr.number ? ` #${pr.number}` : "";
  const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open";
  return `Pull request${num} (${state})`;
}

/** Milliseconds for a row's last activity (0 when unknown, so it sorts last).
 *  updatedAt can be an epoch-ms number or an ISO string depending on the node. */
export function toMs(value: number | string | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** Compact relative age (e.g. "2m", "3h", "5d"), matching the legacy client's
 *  `relTime`. Empty when the timestamp is unknown. */
export function relTime(value: number | string | undefined): string {
  const ms = toMs(value);
  if (!ms) return "";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Second-line descriptor under the session title — parity with the legacy
 *  drawer's `[statusLabel, nodeName, sub].join(" · ")` meta line, minus the
 *  status label (the dot + its title already carry that here). */
function sessionRepo(s: { source?: string }): string {
  return repoFromSource(s.source) || githubIssueRefFromSource(s.source)?.repo || "";
}

function sessionMeta(
  s: { source?: string; branch?: string; agentName?: string; nodeId?: string; forkedFrom?: string },
  nodeLabel: string | null,
): string {
  // Keep the title row for the human title + state badges. Agent/runtime names
  // and repo/branch context are supporting details, so they live on the quieter
  // second line where they don't steal the tiny sidebar's most valuable pixels.
  // GitHub-issue/queue sessions run in a disposable worktree with no branch and
  // no `repo:` source, so fall back to their originating issue/queue ref (the
  // only useful context) — mirrors GithubQueue's queueSessionMeta.
  // A fork gets a one-word "Forked" flag up front — parity with the run pill's
  // own "Forked from" row (RunPill.tsx), for the rows that never open the pill.
  const parts = [s.forkedFrom ? "Forked" : null, s.agentName, nodeLabel, s.branch || repoFromSource(s.source) || queueSourceMeta(s.source)];
  return parts.filter(Boolean).join(" · ");
}

/** Repo/issue (or queue) descriptor for a GitHub-app-spawned session's source,
 *  so these rows read meaningfully in the sidebar now that they show here too
 *  (they carry no branch and no `repo:` source). Empty for ordinary sources. */
function queueSourceMeta(source: string | undefined): string {
  const ref = githubIssueRefFromSource(source);
  if (ref) return `${ref.repo} #${ref.issueNumber}`;
  if (typeof source === "string" && source.startsWith("queue:")) {
    const rest = source.slice("queue:".length);
    if (rest === "slack") return "Slack";
    if (rest === "github:comment") return "GitHub @-mention";
    if (rest === "github:issue") return "GitHub issue";
    return rest || "Queue";
  }
  return "";
}

// A bottom action sheet, not an inline popover: the session list is a scroll
// container (overflow-y:auto also clips overflow-x), so an absolutely-positioned
// popover on a lower row was cut off and its actions became unreachable on small
// screens. The sheet is fixed to the viewport and escapes that clipping entirely.
function RowMenu({ sessionId, name, isRepo, prs }: { sessionId: string; name: string; isRepo: boolean; prs?: PrRef[] }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  // `controller.refreshPrStatus` is fire-and-forget — the only signal it
  // finished (or errored) is the shared `prResult`/`error` state. Watch both so
  // tapping "Update GitHub status" doesn't just look like nothing happened
  // while the node is thinking.
  const { prResult, error } = useAppState();
  const prBusyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!prBusy) return;
    // Either outcome — a fresh prResult or a fresh error (ErrorToast will show
    // it) — means the status round trip finished.
    setPrBusy(false);
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to either changing, not to prBusy itself
  }, [prResult, error]);

  useEffect(() => () => { if (prBusyTimer.current) clearTimeout(prBusyTimer.current); }, []);

  const close = () => setOpen(false);
  const rename = () => {
    close();
    setRenaming(true);
  };
  const del = () => {
    close();
    setDeleting(true);
  };
  const refreshPrStatus = () => {
    setPrBusy(true);
    controller.refreshPrStatus(sessionId);
    if (prBusyTimer.current) clearTimeout(prBusyTimer.current);
    prBusyTimer.current = setTimeout(() => { setPrBusy(false); setOpen(false); }, PR_BUSY_TIMEOUT_MS);
  };
  // Continue a warm-replicated session on THIS node when its owner is offline
  // (docs/session-replication.md). The node runs the control-plane epoch CAS and
  // materializes the replica; on failure the reply rejects and the toast surfaces.
  const promote = () => {
    setPrBusy(true);
    controller.promoteSession(sessionId, controller.local.cur)
      .catch(() => {})
      .finally(() => { setPrBusy(false); setOpen(false); });
  };

  return (
    <div className="row-menu">
      <button
        className="row-menu-btn"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {renaming && (
        <RenameDialog
          title="Rename session"
          initialValue={name}
          onCancel={() => setRenaming(false)}
          onSave={(next) => { controller.renameSession(sessionId, next); setRenaming(false); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete session?"
          message={`Delete “${name}”? This can't be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={() => { controller.deleteSession(sessionId); setDeleting(false); }}
        />
      )}
      {/* The mobile sidebar is transformed into an off-canvas drawer. A fixed
          descendant of a transformed element is fixed to that element, not the
          viewport, so keep the full-screen sheet at the document root. */}
      {open && createPortal(
        <div className="action-sheet" role="dialog" aria-modal="true" aria-label={`Actions for ${name}`} onClick={(e) => e.stopPropagation()}>
          <div className="action-sheet-backdrop" onClick={close} />
          <div className="action-sheet-body">
            <div className="action-sheet-head">
              <span className="action-sheet-title">{name}</span>
              <button className="action-sheet-close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>
            <button className="action-sheet-item" onClick={rename} disabled={prBusy}>
              Rename
            </button>
            {/* Every PR the session has (open, merged, closed) as a direct link —
                this is how multiple PRs on one session stay reachable without
                cluttering the row. */}
            {(prs ?? []).map((pr) => (
              <a key={pr.url} className="action-sheet-item" href={pr.url} target="_blank" rel="noopener" onClick={close}>
                {prActionLabel(pr)}
              </a>
            ))}
            {/* Force a fresh GitHub check regardless of what this session last saw —
                the badge only updates opportunistically (after a turn), so a
                session that's finished or not attached keeps a stale `open` PR
                until something nudges it. Always offered for a repo session, PR
                or not, so a merge/close is one tap away from being reflected. */}
            {isRepo && (
              <button className="action-sheet-item" onClick={refreshPrStatus} disabled={prBusy}>
                {prBusy ? "Checking GitHub status…" : "Update GitHub status"}
              </button>
            )}
            <button className="action-sheet-item" onClick={promote} disabled={prBusy}>
              Continue here (promote replica)
            </button>
            <button className="action-sheet-item danger" onClick={del} disabled={prBusy}>
              Delete
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Only this many rows are shown at rest; the rest reveal in pages on demand.
// The full list is cheap to hold (they're summaries), but rendering hundreds of
// rows — each with a status dot, meta line, and action sheet — is not, so cap
// what's mounted and let the user page through the tail.
const PAGE = 10;

export function SessionList({ onPick, onPickTerminal, runEvidence }: { onPick: (sessionId: string, path?: string, nodeId?: string) => void; onPickTerminal: (termId: string, nodeId?: string) => void; runEvidence?: Map<string, GithubQueueItem> }) {
  const { sessions, runTerminals, activeSessionId, nodes, currentNodeId } = useAppState();
  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  // Live status (working/needs-action/idle) arrives by push for every session,
  // focused or not (see packages/core/src/store.ts session.event handling) —
  // but that only fires while something is actually happening. This is a
  // safety net so a session someone else closed/opened, or a status change
  // missed during a brief reconnect, doesn't leave a stale dot indefinitely.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") controller.refreshSessions();
    }, 25000);
    return () => clearInterval(id);
  }, []);

  // Live `bivy run` rows only arrive via terminal.list on the connected node.
  // Pull them once on mount (and whenever the user lands back on the list) so a
  // currently-running agent appears without requiring a manual node re-click.
  useEffect(() => {
    controller.refreshSessions();
  }, []);

  // Mirrors NodeSwitcher's own visibility rule (App.tsx: `!controller.direct`)
  // rather than gating on node count — even a single-node relay account still
  // benefits from seeing which (possibly ephemeral) node a session lives on.
  // Direct/local mode has no node concept at all, so there's nothing to show.
  // Before `nodes` has loaded, fall back to nothing rather than the raw node
  // id/UUID — a friendly name or no meta segment beats a UUID on every row.
  const nodeName = (nodeId?: string) => controller.direct || !nodeId ? null : nodes.find((n) => n.id === nodeId)?.name || nodeId;

  const repoOptions = useMemo(() => {
    return Array.from(new Set(sessions.map(sessionRepo).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const filteredRuns = useMemo(() => {
    // Run terminals don't carry a canonical GitHub repo, so a repo filter hides
    // them entirely rather than pretending a workspace basename is a repo
    // identity. A node filter narrows to that terminal's own owning node —
    // like sessions, every node's terminals belong in this unified sidebar,
    // not just the currently connected node's (issue #99).
    if (repoFilter) return [];
    let matched = runTerminals;
    if (nodeFilter) matched = matched.filter((t) => (t.nodeId || currentNodeId) === nodeFilter);
    const q = query.trim().toLowerCase();
    if (q) matched = matched.filter((t) => `${t.name ?? ""} ${t.label ?? ""} ${t.agent ?? ""} ${t.workspace ?? ""}`.toLowerCase().includes(q));
    return [...matched].sort((a, b) => toMs(b.lastActivityAt ?? b.createdAt) - toMs(a.lastActivityAt ?? a.createdAt));
  }, [runTerminals, query, repoFilter, nodeFilter, currentNodeId]);

  const filtered = useMemo(() => {
    // Sessions the GitHub-app queue spawned (a labelled issue or @-mention
    // picked up automatically) still get their own "GitHub Queue" screen, but
    // they now also appear here in the main sidebar so they're reachable the
    // same way as any other session — not buried one screen deep.
    const q = query.trim().toLowerCase();
    const matched = sessions.filter((s) => {
      const repo = sessionRepo(s);
      if (nodeFilter && s.nodeId !== nodeFilter) return false;
      if (repoFilter && repo !== repoFilter) return false;
      return !q || `${s.name} ${s.source ?? ""} ${s.agentName ?? ""} ${repo}`.toLowerCase().includes(q);
    });
    // Sessions that need a human float to the top (an agent blocked on an
    // approval/question, then a finished run you haven't seen) — the old
    // separate "inbox" is gone, so the list itself has to surface what needs
    // you. Within the same attention rank it's newest-activity-first, so the
    // calm majority still reads like the legacy drawer. Sort a copy so the
    // store's array identity is untouched.
    return [...matched].sort(
      // Trial-locked stubs sink to the bottom — they can't be opened, so they
      // shouldn't crowd the sessions that need attention. Otherwise: needs-you
      // first, then newest activity.
      (a, b) =>
        (a.locked ? 1 : 0) - (b.locked ? 1 : 0) ||
        attentionRank(b) - attentionRank(a) ||
        toMs(b.updatedAt) - toMs(a.updatedAt),
    );
  }, [sessions, query, repoFilter, nodeFilter]);

  // Sessions the control plane withheld because the account is past its free
  // lifetime-session trial (see listClientSessions). Their presence drives the
  // paywall banner and per-row lock treatment below.
  const lockedCount = useMemo(() => sessions.filter((s) => s.locked).length, [sessions]);

  // Search spans every session; pagination only bounds the unfiltered list, so a
  // query always reveals all of its matches, never just the first page.
  const filtering = repoFilter.length > 0 || nodeFilter.length > 0;
  const searching = query.trim().length > 0;
  const visible = searching || filtering ? filtered : filtered.slice(0, visibleCount);
  const hiddenCount = filtered.length - visible.length;

  // Collapse back to the first page whenever the query changes (including when
  // it's cleared) so clearing a search doesn't leave the list expanded.
  useEffect(() => {
    setVisibleCount(PAGE);
  }, [query, repoFilter, nodeFilter]);

  const activeFilterCount = (repoFilter ? 1 : 0) + (nodeFilter ? 1 : 0);
  const filterSummary = [nodeFilter ? nodeName(nodeFilter) : !controller.direct ? "All machines" : null, repoFilter || null].filter(Boolean).join(" · ");
  const emptyText = query.trim() || repoFilter || nodeFilter
    ? "No matching sessions."
    : "No sessions yet. Use ＋ New to start one.";

  const runMeta = (t: RunTerminalSummary): string => {
    const workspace = String(t.workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return [t.label || t.agent, nodeName(t.nodeId || currentNodeId || undefined), workspace].filter(Boolean).join(" · ");
  };

  return (
    <div className="session-list">
      <div className="session-list-tools">
        <input
          className="session-search"
          type="search"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="session-filter" ref={filterRef}>
          <button
            className={`session-filter-btn${activeFilterCount ? " active" : ""}`}
            type="button"
            aria-label="Filter sessions"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={(e) => {
              e.stopPropagation();
              if (!controller.direct && nodes.length === 0) void controller.refreshNodes();
              setFilterOpen((v) => !v);
            }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5h18l-7 8v6l-4-2v-4z" />
            </svg>
            {activeFilterCount > 0 && <span className="session-filter-count">{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <div className="session-filter-menu" role="menu">
              {!controller.direct && (
                <div className="session-filter-section">
                  <div className="session-filter-head">Machine</div>
                  <button
                    className="session-filter-item"
                    role="menuitemradio"
                    aria-checked={!nodeFilter}
                    onClick={() => {
                      setNodeFilter("");
                      setFilterOpen(false);
                    }}
                  >
                    <span>All machines</span>
                    {!nodeFilter && <span className="session-filter-check">✓</span>}
                  </button>
                  {nodes.length === 0 ? (
                    <div className="session-filter-empty">No machines</div>
                  ) : (
                    nodes.map((n) => (
                      <button
                        key={n.id}
                        className="session-filter-item"
                        role="menuitemradio"
                        aria-checked={n.id === nodeFilter}
                        onClick={() => {
                          setNodeFilter(n.id);
                          setFilterOpen(false);
                        }}
                      >
                        <span>{n.name || n.id}</span>
                        {n.id === nodeFilter && <span className="session-filter-check">✓</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
              <div className="session-filter-section">
                <div className="session-filter-head">GitHub repo</div>
                <button
                  className="session-filter-item"
                  role="menuitemradio"
                  aria-checked={!repoFilter}
                  onClick={() => {
                    setRepoFilter("");
                    setFilterOpen(false);
                  }}
                >
                  <span>All repositories</span>
                  {!repoFilter && <span className="session-filter-check">✓</span>}
                </button>
                {repoOptions.length === 0 && <div className="session-filter-empty">No GitHub repos</div>}
                {repoOptions.map((repo) => (
                  <button
                    key={repo}
                    className="session-filter-item"
                    role="menuitemradio"
                    aria-checked={repo === repoFilter}
                    onClick={() => {
                      setRepoFilter(repo);
                      setFilterOpen(false);
                    }}
                  >
                    <span>{repo}</span>
                    {repo === repoFilter && <span className="session-filter-check">✓</span>}
                  </button>
                ))}
              </div>
              <div className="session-filter-foot">
                <span className="session-filter-summary">{filterSummary}</span>
                {(repoFilter || nodeFilter) && <button className="session-filter-clear" onClick={() => { setRepoFilter(""); setNodeFilter(""); }}>Clear</button>}
              </div>
            </div>
          )}
        </div>
      </div>
      {lockedCount > 0 && (
        <div className="trial-wall" role="note">
          <div className="trial-wall-text">
            <strong>{lockedCount} session{lockedCount === 1 ? "" : "s"} hidden</strong>
            <span>
              You've reached the free Bivy Cloud limit. Subscribe to Pro to view and
              control every session from anywhere — or run your own self-hosted Bivy
              server to keep everything free.
            </span>
          </div>
          <button className="trial-wall-cta" type="button" onClick={() => void controller.startCheckout()}>
            Upgrade to Pro
          </button>
        </div>
      )}
      {filtered.length === 0 && filteredRuns.length === 0 && <div className="session-empty">{emptyText}</div>}
      <ul>
        {filteredRuns.map((t) => {
          const title = t.name || t.label || t.agent || "Terminal session";
          const meta = runMeta(t);
          return (
            <li key={t.termId} className="session-row">
              <button className="session-item" onClick={() => onPickTerminal(t.termId, t.nodeId)}>
                <RowMark kind={CLI_SOURCE.kind} status="working" srLabel={`${CLI_SOURCE.label} · Running in terminal`} />
                <span className="session-body">
                  <span className="session-title-row">
                    <span className="session-name">{title}</span>
                    {relTime(t.lastActivityAt ?? t.createdAt) && (
                      <span className="session-age" title="Running in terminal">
                        {relTime(t.lastActivityAt ?? t.createdAt)}
                      </span>
                    )}
                  </span>
                  {meta && <span className="session-meta">{meta}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {visible.map((s) => {
          // Trial-locked stub: no content to show and not openable. Render a muted
          // lock row that routes to checkout instead of opening the session.
          if (s.locked) {
            return (
              <li key={s.sessionId} className="session-row">
                <button
                  className="session-item locked"
                  type="button"
                  aria-label="Locked session — upgrade to view"
                  onClick={() => void controller.startCheckout()}
                >
                  <span className="session-lock" aria-hidden>🔒</span>
                  <span className="session-body">
                    <span className="session-title-row">
                      <span className="session-name">Locked session</span>
                      {relTime(s.updatedAt) && <span className="session-age">{relTime(s.updatedAt)}</span>}
                    </span>
                    <span className="session-meta">
                      <span className="row-hint warn">Subscribe to Pro to view</span>
                      {nodeName(s.nodeId) ? ` · ${nodeName(s.nodeId)}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          }
          const meta = sessionMeta(s, nodeName(s.nodeId));
          const unseen = isUnseen(s);
          const label = statusLabel(s);
          const src = classifySource(s.source);
          // A one-word exception hint on failed / waiting-on-you runs, so those
          // rows pop in a long list; null (no extra text) for the calm majority.
          // A run-evidence hint (the specific "what": e.g. an approval prompt or
          // a failed check) wins; otherwise, since a needs-action or unseen row
          // has floated to the top, spell out why with its status label so the
          // list itself says what needs you — no separate inbox required.
          const hint =
            rowHint(runEvidence?.get(s.sessionId)) ??
            (attentionRank(s) > 0 ? { text: statusLabel(s), tone: "warn" as const } : null);
          const failedLaunch = s.pendingLaunch && s.status === "failed";
          return (
            <li key={s.sessionId} className="session-row">
              <button
                className={`session-item${s.sessionId === activeSessionId ? " active" : ""}`}
                onClick={() => onPick(s.sessionId, s.path, s.nodeId)}
              >
                <RowMark kind={src.kind} status={statusClass(s)} unseen={unseen} srLabel={`${src.label} · ${label}`} />
                <span className="session-body">
                  <span className="session-title-row">
                    <span className="session-name">{s.name}</span>
                    <PrBadge prs={s.prs} />
                    {relTime(s.updatedAt) && (
                      <span className="session-age" title={label}>
                        {relTime(s.updatedAt)}
                      </span>
                    )}
                  </span>
                  {(hint || meta) && (
                    <span className="session-meta">
                      {hint && <span className={`row-hint ${hint.tone}`}>{hint.text}</span>}
                      {hint && meta ? " · " : ""}
                      {meta}
                    </span>
                  )}
                </span>
              </button>
              {failedLaunch ? (
                <span className="pending-launch-actions">
                  <button type="button" onClick={() => void controller.retryPendingLaunch(s.sessionId)}>Retry</button>
                  <button type="button" onClick={() => void controller.dismissPendingLaunch(s.sessionId)}>Dismiss</button>
                </span>
              ) : (controller.direct || !s.nodeId || s.nodeId === currentNodeId) && (
                <RowMenu sessionId={s.sessionId} name={s.name} isRepo={Boolean(repoFromSource(s.source))} prs={s.prs} />
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <button className="session-more" onClick={() => setVisibleCount((n) => n + PAGE)}>
          Show more ({hiddenCount})
        </button>
      )}
    </div>
  );
}
