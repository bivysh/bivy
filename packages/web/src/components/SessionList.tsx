// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LibraryView } from "../router.js";
import { githubIssueRefFromSource, primaryPr, repoFromSource, type GithubQueueItem, type PrRef, type RunTerminalSummary } from "@bivy/core";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { attentionRank, statusDotState, statusLabel, type SessionDotState } from "../sessionStatus.js";
import { Badge } from "./Badge.js";
import { classifySource, CLI_SOURCE, shortSourceLabel, type SourceInfo } from "../sessionSource.js";
import { StatusDot } from "./StatusDot.js";
import { SourceMark } from "./SourceMark.js";
import { rowHint } from "../runEvidence.js";
import { sessionDateGroup } from "../sessionPresentation.js";
import { CheckIcon, SearchIcon } from "./UiIcons.js";
import { ConfirmDialog } from "./AppDialog.js";

/** Row states loud enough to earn a visible dot. The calm majority (idle /
 *  saved) carries none, so a dot in the list always means "look here". */
const LOUD_STATES: ReadonlySet<SessionDotState> = new Set(["working", "needs-action", "failed", "unseen"]);

/** The leading indicator on a session row: the canonical StatusDot, shown only
 *  for states that want attention. Rows otherwise start flush with the title,
 *  like a plain list of conversations. The full source + status is always
 *  mirrored as screen-reader text. */
export function RowMark({ status, srLabel }: { status: SessionDotState; srLabel: string }) {
  return (
    <>
      {LOUD_STATES.has(status) && <span className="row-status"><StatusDot status={status} /></span>}
      <span className="sr-only">{srLabel}</span>
    </>
  );
}

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

/** Per-state PR presentation: the glyph's shape carries the state (so it never
 *  rests on colour alone), the tone colours it, the label names it. */
const PR_STATE = {
  open: { label: "Open pull request", tone: "ok", paths: ["M13 6h3a2 2 0 0 1 2 2v7", "M6 9v12"] },
  merged: { label: "Merged", tone: "merged", paths: ["M6 21V9a9 9 0 0 0 9 9"] },
  closed: { label: "Closed pull request", tone: undefined, paths: ["M6 9v12", "m21 3-6 6", "m21 9-6-6", "M18 11.5V15"] },
} as const;

/** Compact PR status mark: a pull-request glyph shaped by state, plus a count
 *  when a session carries more than one. Shows the primary PR (open wins, else
 *  most recent). Non-interactive (the row/pill around it is the button). */
export function PrBadge({ prs }: { prs?: PrRef[] }) {
  const pr = primaryPr(prs);
  if (!pr) return null;
  const state = PR_STATE[pr.state === "merged" || pr.state === "closed" ? pr.state : "open"];
  const count = prs && prs.length > 1 ? prs.length : 0;
  const label = count ? `${state.label} · ${count} pull requests` : state.label;
  return (
    <Badge tone={state.tone} variant="soft" className="session-pr" title={label}>
      <svg className="pr-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="18" r="3" />
        {state.paths.map((d) => <path key={d} d={d} />)}
      </svg>
      {count > 0 && <span className="session-pr-text" aria-hidden>{count}</span>}
      <span className="sr-only">{label}</span>
    </Badge>
  );
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
  s: { name?: string; source?: string; branch?: string; agentName?: string; nodeId?: string; forkedFrom?: string },
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
  const repo = repoFromSource(s.source) || githubIssueRefFromSource(s.source)?.repo || "";
  const branch = s.branch || "";
  // Repo and branch are separate identifiers: a branch must not hide which
  // repository owns it. Suppress only a branch that is effectively a generated
  // slug of the human title; it remains searchable below.
  const titleSlug = String(s.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const branchSlug = branch.toLowerCase().split("/").pop()?.replace(/-[a-f0-9]{5,}$/i, "") || "";
  const usefulBranch = branch && branchSlug !== titleSlug ? branch : "";
  // An automation-triggered session names its trigger up front ("Schedule",
  // "Slack"); hand-opened ones stay quiet — they're the default. A queue
  // descriptor that would only repeat that trigger name is dropped.
  const src = classifySource(s.source);
  const context = repo || (src.automation ? "" : queueSourceMeta(s.source));
  const parts = [src.automation ? shortSourceLabel(src.kind) : null, s.forkedFrom ? "Forked" : null, s.agentName, nodeLabel, context, usefulBranch];
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

// Only this many rows are shown at rest; the rest reveal in pages on demand.
// The full list is cheap to hold (they're summaries), but rendering hundreds of
// rows — each with a status dot, meta line, and action sheet — is not, so cap
// what's mounted and let the user page through the tail.
const PAGE = 10;

/** The sidebar's machine-wide pages, below Automations. */
const LIBRARY_NAV: { view: LibraryView; label: string; icon: ReactNode }[] = [
  { view: "artifacts", label: "Artifacts", icon: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></> },
  { view: "apps", label: "Apps", icon: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></> },
];

export function SessionList({ onPick, onPickTerminal, runEvidence, sessionSources, onOpenAutomations, automationsActive, onOpenLibrary, libraryActive, onOpenTerminal, terminalDisabled }: { onPick: (sessionId: string, path?: string, nodeId?: string) => void; onPickTerminal: (termId: string, nodeId?: string) => void; runEvidence?: Map<string, GithubQueueItem>; sessionSources?: Map<string, SourceInfo>; onOpenAutomations?: () => void; automationsActive?: boolean; onOpenLibrary?: (view: LibraryView) => void; libraryActive?: LibraryView | null; onOpenTerminal?: () => void; terminalDisabled?: boolean }) {
  const { sessionIndex: { sessions, runTerminals }, activeSession: { activeSessionId }, connection: { nodes, currentNodeId } } = useAppState();
  const [query, setQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
  // Push is authoritative during normal use; keep this recovery poll calm since
  // each refresh traverses both the node relay and the account session index.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") controller.refreshSessions();
    }, 60000);
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
  // On the row's meta line the machine only helps tell sessions apart when
  // there's more than one to tell apart; with a single machine it's the same
  // word on every row. (Search and the filter menu still use nodeName.)
  const rowNodeName = (nodeId?: string) => nodes.length > 1 ? nodeName(nodeId) : null;

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
    // A `bivy run` pinned to a session id is one conversation with two node-side
    // representations: the live PTY (runTerminals, rendered above under
    // "Running" — the row that can attach or continue in chat) and its durable
    // session (status "working" while the PTY lives, "saved" after). Show the
    // Running row while we know of the PTY, never both; the session row takes
    // over the moment terminal.closed removes the PTY from the store.
    const liveRunSessionIds = new Set(runTerminals.map((t) => t.sessionId).filter(Boolean));
    const matched = sessions.filter((s) => {
      if (liveRunSessionIds.has(s.sessionId)) return false;
      const repo = sessionRepo(s);
      if (nodeFilter && s.nodeId !== nodeFilter) return false;
      if (repoFilter && repo !== repoFilter) return false;
      const searchableNode = controller.direct || !s.nodeId ? "" : nodes.find((node) => node.id === s.nodeId)?.name || "";
      const searchable = [s.name, s.source, s.agentName, repo, s.branch, s.nodeId, searchableNode].filter(Boolean).join(" ");
      return !q || searchable.toLowerCase().includes(q);
    });
    // Sessions that need a human float to the top (an agent blocked on an
    // approval/question, then a finished run you haven't seen) — the old
    // separate "inbox" is gone, so the list itself has to surface what needs
    // you. Within the same attention rank it's newest-activity-first, so the
    // calm majority still reads like the legacy drawer. Sort a copy so the
    // store's array identity is untouched.
    return [...matched].sort(
      (a, b) => attentionRank(b) - attentionRank(a) || toMs(b.updatedAt) - toMs(a.updatedAt),
    );
  }, [sessions, runTerminals, nodes, query, repoFilter, nodeFilter]);

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
    : "No sessions yet. Start one with New session.";

  const runMeta = (t: RunTerminalSummary): string => {
    const workspace = String(t.workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return [t.label || t.agent, rowNodeName(t.nodeId || currentNodeId || undefined), workspace].filter(Boolean).join(" · ");
  };

  return (
    <div className="session-list">
      {deleteTarget && <ConfirmDialog
        title="Delete saved session?"
        message={`Delete “${deleteTarget.name}” and its saved Cloud history? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const id = deleteTarget.sessionId;
          setDeleteTarget(null);
          setDeletingId(id);
          void controller.deleteSession(id).catch(() => controller.store.setError("Couldn't delete the session.")).finally(() => setDeletingId(null));
        }}
      />}
      {(onOpenAutomations || onOpenLibrary || onOpenTerminal) && (
        <nav className="sidebar-nav" aria-label="Workspace">
          {onOpenAutomations && (
            <button className={`sidebar-nav-item${automationsActive ? " active" : ""}`} onClick={onOpenAutomations} aria-current={automationsActive ? "page" : undefined}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 2 3 14h9l-1 8 10-12h-9z" />
              </svg>
              <span>Automations</span>
            </button>
          )}
          {onOpenLibrary && LIBRARY_NAV.map(({ view, label, icon }) => (
            <button key={view} className={`sidebar-nav-item${libraryActive === view ? " active" : ""}`} onClick={() => onOpenLibrary(view)} aria-current={libraryActive === view ? "page" : undefined}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>
              <span>{label}</span>
            </button>
          ))}
          {/* Standalone terminal: independent of any session, opened at the
              picked node's workspace folder (#460). */}
          {onOpenTerminal && (
            <button className="sidebar-nav-item" onClick={onOpenTerminal} disabled={terminalDisabled} aria-label="Open standalone terminal">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 9 3 3-3 3" />
                <path d="M13 15h4" />
              </svg>
              <span>Terminal</span>
            </button>
          )}
        </nav>
      )}
      <div className="session-list-tools">
        <label className="session-search-wrap">
          <SearchIcon size={17} aria-hidden />
          <input
            className="field session-search"
            type="search"
            aria-label="Search sessions"
            placeholder={sessions.length > 1 ? `Search ${sessions.length} sessions` : "Search sessions"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="session-filter" ref={filterRef}>
          <button
            className={`session-filter-btn${activeFilterCount ? " active" : ""}`}
            type="button"
            aria-label={activeFilterCount ? `Filter sessions, ${filterSummary}` : "Filter sessions"}
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
            {activeFilterCount > 0 && <Badge tone="accent" variant="solid" className="session-filter-count">{activeFilterCount}</Badge>}
          </button>
          {filterOpen && (
            <div className="menu session-filter-menu" role="menu">
              {!controller.direct && (
                <div className="session-filter-section">
                  <div className="session-filter-head">Machine</div>
                  <button
                    className="menu-item session-filter-item"
                    role="menuitemradio"
                    aria-checked={!nodeFilter}
                    onClick={() => {
                      setNodeFilter("");
                      setFilterOpen(false);
                    }}
                  >
                    <span>All machines</span>
                    {!nodeFilter && <span className="session-filter-check"><CheckIcon size={15} /></span>}
                  </button>
                  {nodes.length === 0 ? (
                    <div className="session-filter-empty">No machines</div>
                  ) : (
                    nodes.map((n) => (
                      <button
                        key={n.id}
                        className="menu-item session-filter-item"
                        role="menuitemradio"
                        aria-checked={n.id === nodeFilter}
                        onClick={() => {
                          setNodeFilter(n.id);
                          setFilterOpen(false);
                        }}
                      >
                        <span>{n.name || n.id}</span>
                        {n.id === nodeFilter && <span className="session-filter-check"><CheckIcon size={15} /></span>}
                      </button>
                    ))
                  )}
                </div>
              )}
              <div className="session-filter-section">
                <div className="session-filter-head">GitHub repo</div>
                <button
                  className="menu-item session-filter-item"
                  role="menuitemradio"
                  aria-checked={!repoFilter}
                  onClick={() => {
                    setRepoFilter("");
                    setFilterOpen(false);
                  }}
                >
                  <span>All repositories</span>
                  {!repoFilter && <span className="session-filter-check"><CheckIcon size={15} /></span>}
                </button>
                {repoOptions.length === 0 && <div className="session-filter-empty">No GitHub repos</div>}
                {repoOptions.map((repo) => (
                  <button
                    key={repo}
                    className="menu-item session-filter-item"
                    role="menuitemradio"
                    aria-checked={repo === repoFilter}
                    onClick={() => {
                      setRepoFilter(repo);
                      setFilterOpen(false);
                    }}
                  >
                    <span>{repo}</span>
                    {repo === repoFilter && <span className="session-filter-check"><CheckIcon size={15} /></span>}
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
      {filtered.length === 0 && filteredRuns.length === 0 && <div className="session-empty">{emptyText}</div>}
      <ul>
        {filteredRuns.length > 0 && <li className="session-group-label">Running</li>}
        {filteredRuns.map((t) => {
          const title = t.name || t.label || t.agent || "Terminal session";
          const meta = runMeta(t);
          return (
            <li key={t.termId} className="session-row">
              <button className="session-item" onClick={() => onPickTerminal(t.termId, t.nodeId)}>
                <span className="session-body">
                  <span className="session-title-row">
                    <RowMark status="working" srLabel={`${CLI_SOURCE.label} · Running in terminal`} />
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
        {visible.map((s, index) => {
          const group = attentionRank(s) > 0 ? "Needs attention" : sessionDateGroup(s.updatedAt);
          const previous = index > 0 ? visible[index - 1] : undefined;
          const previousGroup = previous
            ? attentionRank(previous) > 0 ? "Needs attention" : sessionDateGroup(previous.updatedAt)
            : null;
          const groupHeading = group !== previousGroup
            ? <li className="session-group-label">{group}</li>
            : null;
          const meta = sessionMeta(s, rowNodeName(s.nodeId) || s.pendingNodeName || null);
          const label = statusLabel(s);
          const src = sessionSources?.get(s.sessionId) ?? classifySource(s.source);
          // A one-word exception hint on failed / waiting-on-you runs, so those
          // rows pop in a long list; null (no extra text) for the calm majority.
          // A run-evidence hint (the specific "what": e.g. an approval prompt or
          // a failed check) wins; otherwise, since a needs-action or unseen row
          // has floated to the top, spell out why with its status label so the
          // list itself says what needs you — no separate inbox required.
          const hint =
            rowHint(runEvidence?.get(s.sessionId)) ??
            (attentionRank(s) > 0
              ? {
                  text: statusLabel(s),
                  tone: (s.status === "failed" || s.status === "needs_action" || s.needsAction ? "danger" : "warn") as "danger" | "warn",
                }
              : null);
          const failedLaunch = s.pendingLaunch && s.status === "failed";
          return (
            <Fragment key={s.sessionId}>
              {groupHeading}
              <li className="session-row">
              <button
                className={`session-item${s.sessionId === activeSessionId ? " active" : ""}`}
                aria-current={s.sessionId === activeSessionId ? "page" : undefined}
                onClick={() => onPick(s.sessionId, s.path, s.nodeId)}
              >
                <span className="session-body">
                  <span className="session-title-row">
                    <RowMark status={statusDotState(s)} srLabel={`${src.label} · ${label}`} />
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
                      {/* An automation names its trigger with the canonical source
                          glyph (the meta text spells it out beside it). */}
                      {src.automation && <SourceMark kind={src.kind} size="xs" />}
                      {hint && <span className={`row-hint ${hint.tone}`}>{hint.text}</span>}
                      {hint && meta ? " · " : ""}
                      {meta}
                    </span>
                  )}
                </span>
              </button>
              {s.rebuildable && !s.pendingLaunch && (
                <span className="pending-launch-actions">
                  <button type="button" disabled={deletingId === s.sessionId} aria-label={`Delete ${s.name}`} onClick={() => setDeleteTarget({ sessionId: s.sessionId, name: s.name || "Saved session" })}>
                    {deletingId === s.sessionId ? "Deleting…" : "Delete"}
                  </button>
                </span>
              )}
              {failedLaunch && (
                <span className="pending-launch-actions">
                  <button type="button" onClick={() => void controller.retryPendingLaunch(s.sessionId)}>Retry</button>
                  <button type="button" onClick={() => void controller.dismissPendingLaunch(s.sessionId)}>Dismiss</button>
                </span>
              )}
              </li>
            </Fragment>
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
