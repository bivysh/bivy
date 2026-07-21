// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

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

export class MetadataStore {
  private filePath: string;
  private data: MetadataFile;

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
      store.save();
      return store;
    }
  }

  private save() {
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
   * number of rows reset.
   */
  resetStaleWorking(): number {
    let reset = 0;
    for (const [id, session] of Object.entries(this.data.sessions)) {
      if (session.status === "working") {
        this.data.sessions[id] = { ...session, status: "idle" };
        reset++;
      }
    }
    if (reset > 0) this.save();
    return reset;
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
