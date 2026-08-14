// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import type { SessionContract } from "./session/session-contract.js";

/** State of a pull request as GitHub reports it. "merged" is a closed PR whose
 *  `merged_at` is set — surfaced separately so the UI can distinguish it from a
 *  PR that was closed without merging. */
export type PrState = "open" | "merged" | "closed";

/** A pull request opened for a session's branch. A session can accumulate more
 *  than one over its life (e.g. a first PR merges and later work opens another),
 *  so these are tracked as a list; `prUrl` remains the single *open* PR for
 *  back-compat and the "already has a PR" guards. */
export interface PrRef {
  url: string;
  number?: number;
  state: PrState;
  title?: string;
}

export type MetadataSession = {
  id: string;
  path?: string;
  name?: string;
  workspace?: string;
  source?: string;
  /** The parent session's id, when this session was materialized from a fork
   *  bundle (see src/session/fork.ts). A bare identifier — never a prompt,
   *  transcript, or diff — so it's safe to persist and surface in the UI. */
  forkedFrom?: string;
  /** Content-free provenance for a Session created by an unattended Run. Used
   * to preserve child-Run nesting limits across daemon restarts. */
  automationRunId?: string;
  delegationDepth?: number;
  runtimeId?: string;
  /** Per-session sandbox tier override ("read-only" | "workspace-write" |
   *  "danger-full-access"), so resume rebuilds the runtime at the same tier. */
  sandbox?: string;
  agentName?: string;
  status?: string;
  branch?: string;
  worktree?: string;
  prUrl?: string;
  /** Every pull request seen for this session's branch (open, merged, closed). */
  prs?: PrRef[];
  messageCount?: number;
  firstMessage?: string;
  /** Running session cost in USD, as reported by runtimes that surface it (capabilities.usageReporting). Display-only. */
  costUsd?: number;
  /** Running total token count (input+output+cache), same runtimes as costUsd. Display-only. */
  tokensTotal?: number;
  /** Set at boot for a session whose turn was cut off by a process death when the
   *  node runs in "manual" resume mode: the agent is NOT auto-continued, so this
   *  durable flag lets the UI offer a one-tap "Resume" when the session is opened.
   *  Cleared the moment any turn completes on the session (see clearSessionWorking). */
  resumePending?: boolean;
  /** ISO instant a session is scheduled to auto-resume at, set when a turn hit a
   *  provider usage/rate limit and the ruleset says retry-when-it-resets. Durable
   *  so the resume survives a daemon restart (re-armed by the resume sweep);
   *  cleared once the session resumes or otherwise moves on. */
  resumeAt?: string;
  /** How many consecutive auto-resumes have been scheduled for this session since
   *  its last genuine turn (a user prompt, or a resume that actually cleared the
   *  limit). Durable so the cap survives a restart / session re-resolution — both
   *  of which drop the in-memory reroute attempt budget — and a limit that never
   *  clears can't re-send forever. Reset to 0 (absent) whenever a turn ends without
   *  scheduling another resume. */
  resumeAttempts?: number;
  /** The Effective Session Contract resolved once at session creation (see
   *  src/session/session-contract.ts), persisted so a closed/resumed session
   *  still shows what it actually got rather than the node re-deriving a
   *  possibly-different one from the runtime's current catalog entry. */
  contract?: SessionContract;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
};

export type MetadataWorkspace = {
  path: string;
  lastUsedAt: string;
};

export type MetadataApproval = {
  id: string;
  sessionId: string;
  toolName: string;
  reason: string;
  risk?: string;
  status: string;
  createdAt: string;
  resolvedAt?: string;
  workspace?: string;
  repo?: string;
  branch?: string;
};

export type MetadataDevice = {
  id: string;
  label?: string;
  publicKeyB64?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

type MetadataFile = {
  version: 1;
  sessions: Record<string, MetadataSession>;
  workspaces: Record<string, MetadataWorkspace>;
  approvals: Record<string, MetadataApproval>;
  devices: Record<string, MetadataDevice>;
};

function nowIso() { return new Date().toISOString(); }
function iso(value: unknown, fallback = Date.now()) {
  const ms = new Date(value as string | number | Date).getTime();
  return new Date(Number.isFinite(ms) ? ms : fallback).toISOString();
}
function empty(): MetadataFile { return { version: 1, sessions: {}, workspaces: {}, approvals: {}, devices: {} }; }

// Coalescing window for the metadata file. A streaming agent fires a metadata
// mutation (touchSession/upsertSession) per output line; without debouncing,
// each did a synchronous whole-file fsync rewrite whose cost is O(all sessions).
// At many writes/sec × many sessions that is O(sessions²) of blocking work on
// the single event loop — enough to peg a core. Coalescing collapses a burst
// into at most one fsync per window. Durability is bounded to this window: a
// clean shutdown calls flushSync(), and any 'working' row left stale by a hard
// crash is reconciled on restart (resetStaleWorking), so the trade is safe.
const SAVE_DEBOUNCE_MS = 150;

export class MetadataStore {
  private filePath: string;
  private data: MetadataFile;
  /** True when an in-memory mutation has not yet been persisted to disk. */
  private dirty = false;
  /** Pending coalesced-write timer, or null when nothing is queued. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(filePath: string, data: MetadataFile) {
    this.filePath = filePath;
    this.data = data;
  }

  static load(appDir: string) {
    const filePath = path.join(appDir, "metadata.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MetadataFile>;
      return new MetadataStore(filePath, {
        version: 1,
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions as Record<string, MetadataSession> : {},
        workspaces: parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces as Record<string, MetadataWorkspace> : {},
        approvals: parsed.approvals && typeof parsed.approvals === "object" ? parsed.approvals as Record<string, MetadataApproval> : {},
        devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices as Record<string, MetadataDevice> : {},
      });
    } catch {
      const store = new MetadataStore(filePath, empty());
      store.persistNow();
      return store;
    }
  }

  /**
   * Request a persist. Coalesces a burst of mutations into at most one fsync
   * per SAVE_DEBOUNCE_MS instead of a synchronous whole-file fsync per call —
   * the hot-path cost that pegged the event loop. The mutation is already live
   * in memory (the store is the source of truth); only the disk write is
   * deferred. A clean shutdown must call flushSync() to persist the tail.
   */
  private save() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.persistNow();
    }, SAVE_DEBOUNCE_MS);
    // Don't keep the process alive just to flush metadata — a pending write is
    // flushed synchronously on shutdown via flushSync().
    this.saveTimer.unref?.();
  }

  /**
   * Synchronously flush any pending debounced write. Call on shutdown so an
   * in-flight coalesced change isn't lost, or when a caller needs the on-disk
   * file to immediately reflect a just-made mutation.
   */
  flushSync() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.persistNow();
  }

  /** Atomically write the metadata blob (temp file, fsync, rename). Synchronous
   *  and O(all sessions) — reached only through the debounced `save()` or an
   *  explicit `flushSync()`, never once per hot-path mutation. */
  private persistNow() {
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    // fsync the temp file before the atomic rename. Without it the rename can be
    // persisted before the data blocks, so a power cut can surface a zero-length
    // metadata.json and lose the entire session index.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(this.data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }

  upsertSession(input: Partial<MetadataSession> & { id: string }) {
    const prev = this.data.sessions[input.id];
    const createdAt = input.createdAt ?? prev?.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.data.sessions[input.id] = { ...prev, ...input, createdAt, updatedAt };
    this.save();
  }

  touchSession(id: string, status?: string) {
    const prev = this.data.sessions[id];
    if (!prev) return;
    const at = nowIso();
    this.data.sessions[id] = { ...prev, ...(status ? { status } : {}), updatedAt: at, lastActivityAt: at };
    this.save();
  }

  removeSession(id?: string, sessionPath?: string) {
    if (id && this.data.sessions[id]) delete this.data.sessions[id];
    if (sessionPath) {
      const resolved = path.resolve(sessionPath);
      for (const [key, session] of Object.entries(this.data.sessions)) {
        if (session.path && path.resolve(session.path) === resolved) delete this.data.sessions[key];
      }
    }
    this.save();
  }

  markWorktreePruned(id: string) {
    const prev = this.data.sessions[id];
    if (!prev?.worktree) return;
    this.data.sessions[id] = { ...prev, worktree: undefined, updatedAt: nowIso() };
    this.save();
  }

  listSessions() {
    return Object.values(this.data.sessions).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  /**
   * Clear transient "working" status left over from a crash/kill. Call once at
   * boot, before any session is resumed: a fresh process has no live runtimes,
   * so any persisted "working" row is stale. Leaving it set permanently exempts
   * the session's worktree from cleanup (an unbounded disk leak). Returns the
   * ids of the sessions that were reset — i.e. the ones cut off mid-turn by the
   * process death, which the resume reconciler picks up (auto-continue or offer
   * a manual "Resume").
   */
  resetStaleWorking(): string[] {
    const reset: string[] = [];
    for (const [id, session] of Object.entries(this.data.sessions)) {
      if (session.status === "working") {
        this.data.sessions[id] = { ...session, status: "idle" };
        reset.push(id);
      }
    }
    if (reset.length > 0) this.save();
    return reset;
  }

  /** Set/clear the durable "resume pending" flag (manual resume mode). No-op when
   *  the row is missing or already in the requested state, so it never churns the
   *  file on the hot turn-completion path. */
  setResumePending(id: string, pending: boolean) {
    const prev = this.data.sessions[id];
    if (!prev) return;
    if ((prev.resumePending ?? false) === pending) return;
    this.data.sessions[id] = { ...prev, resumePending: pending, updatedAt: nowIso() };
    this.save();
  }

  /** Set/clear the durable auto-resume time (rate/usage-limit recovery). Pass
   *  null to clear. No-op when the row is missing or already in the requested
   *  state, so it never churns the file on the hot turn path. */
  setResumeAt(id: string, resumeAt: string | null) {
    const prev = this.data.sessions[id];
    if (!prev) return;
    const next = resumeAt ?? undefined;
    if ((prev.resumeAt ?? undefined) === next) return;
    this.data.sessions[id] = { ...prev, resumeAt: next, updatedAt: nowIso() };
    this.save();
  }

  /** Set the durable consecutive auto-resume counter (the restart-safe backstop
   *  for the in-memory reroute budget). Pass 0 to clear. No-op when the row is
   *  missing or already in the requested state, so a normal turn (counter already
   *  0) never churns the file. */
  setResumeAttempts(id: string, attempts: number) {
    const prev = this.data.sessions[id];
    if (!prev) return;
    const next = attempts > 0 ? attempts : undefined;
    if ((prev.resumeAttempts ?? undefined) === next) return;
    this.data.sessions[id] = { ...prev, resumeAttempts: next, updatedAt: nowIso() };
    this.save();
  }

  /** Sessions with a durable auto-resume time set — the resume sweep re-arms
   *  these after a restart. */
  sessionsWithResumeAt(): MetadataSession[] {
    return Object.values(this.data.sessions).filter((s) => typeof s.resumeAt === "string" && s.resumeAt);
  }

  /** Look up a session's durable metadata by id, or by session-file path. */
  getSession(idOrPath?: string): MetadataSession | undefined {
    if (!idOrPath) return undefined;
    const direct = this.data.sessions[idOrPath];
    if (direct) return direct;
    const resolved = path.resolve(idOrPath);
    return Object.values(this.data.sessions).find((session) => session.path && path.resolve(session.path) === resolved);
  }

  rememberWorkspace(workspace: string) {
    const resolved = path.resolve(workspace);
    this.data.workspaces[resolved] = { path: resolved, lastUsedAt: nowIso() };
    this.save();
  }

  listWorkspaces() {
    return Object.values(this.data.workspaces).sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()).map((w) => w.path);
  }

  removeWorkspace(workspace: string) {
    delete this.data.workspaces[path.resolve(workspace)];
    this.save();
  }

  recordApproval(input: { id: string; sessionId: string; toolName: string; reason: string; risk?: string; status: string; createdAt: number | string; resolvedAt?: number | string; workspace?: string; repo?: string; branch?: string }) {
    this.data.approvals[input.id] = {
      id: input.id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      reason: input.reason,
      risk: input.risk,
      status: input.status,
      createdAt: iso(input.createdAt),
      resolvedAt: input.resolvedAt ? iso(input.resolvedAt) : undefined,
      workspace: input.workspace,
      repo: input.repo,
      branch: input.branch,
    };
    const entries = Object.entries(this.data.approvals).sort((a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime()).slice(0, 1000);
    this.data.approvals = Object.fromEntries(entries);
    this.save();
  }

  listApprovals(limit = 100) {
    return Object.values(this.data.approvals).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  }

  upsertDevice(input: MetadataDevice) {
    const prev = this.data.devices[input.id];
    this.data.devices[input.id] = { ...prev, ...input, firstSeenAt: input.firstSeenAt ?? prev?.firstSeenAt ?? nowIso(), lastSeenAt: input.lastSeenAt ?? prev?.lastSeenAt };
    this.save();
  }

  revokeDevice(id: string) {
    const prev = this.data.devices[id] ?? { id };
    this.data.devices[id] = { ...prev, revokedAt: nowIso() };
    this.save();
  }

  listDevices() { return Object.values(this.data.devices).sort((a, b) => String(b.lastSeenAt ?? b.firstSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? a.firstSeenAt ?? ""))); }
}
