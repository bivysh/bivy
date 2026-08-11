// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Run-terminal / PTY subsystem, extracted from server.ts. Owns daemon-owned
// `bivy run` / `bivy attach` PTYs: the live-run registry, per-viewer output
// unicast, the quiet-agent idle + terminal-bell push hints, "continue as chat"
// takeover, and the transport-agnostic `terminal.*` message router.
//
// Unlike socket-owned terminals these live in the daemon independent of the
// client that started them (close your laptop, reattach from a phone). The
// TerminalManager singleton and the deep session-lifecycle callbacks
// (refreshRecordAfterTui, broadcastTuiState) stay server-owned and are injected;
// everything the subsystem itself owns (runTerminals, runViewers, the idle/bell
// timer maps, the agent lookup tables) moves here. Credential projection follows
// the unified agent-integration model (#433): only an integration that declares
// bivy/mixed auth receives Bivy vault projections.

import { provisionAgentRun } from "../runtime/credential-provisioning.js";
import { ingestAgentCredentials } from "../runtime/credential-ingest.js";
import { discoverCodexSessionForCwd } from "../runtime/codex-sessions.js";
import { discoverGrokSessionForCwd } from "../runtime/grok-sessions.js";
import { discoverPiSessionForCwd } from "../runtime/pi-session-discovery.js";
import { listMultiplexerSessions, attachCommand, type MultiplexerKind } from "../multiplexer.js";
import type { TerminalManager } from "../terminal.js";
import type { WebSocket } from "ws";

type TuiSpec = { command: string; args: string[]; env?: Record<string, string> };

/** The session fields the run-terminal subsystem reads/writes (TUI lifecycle). */
export interface RunSession {
  id: string;
  workspace: string;
  worktree?: { path?: string };
  tuiTermId?: string;
  tuiRefreshing?: boolean;
  // Method syntax (bivariant) so a concrete RuntimeSession satisfies this. The TUI
  // command may resolve sync or async (RuntimeSession returns spec | Promise | null);
  // the caller awaits it either way.
  session: { cwd?: string; getName(): string | undefined; interactiveTuiCommand?(): TuiSpec | Promise<TuiSpec | null> | null };
}

export interface RunTerminalSpec {
  command: string;
  args: string[];
  agent?: string;
  label?: string;
  name?: string;
  model?: string;
  mux?: string;
  workspace?: string;
  cols?: number;
  rows?: number;
  clientId?: string;
  sessionId?: string;
}

export interface RunTerminalDeps {
  terminals: TerminalManager;
  broadcast(payload: unknown): void;
  sendRelayEvent(event: unknown): void;
  sendNotificationHint(hint: { kind: string; title: string; body: string }): void;
  createSession(workspace: string, sessionFile: string | undefined, opts: { runtimeId: string; makeActive?: boolean; source?: string }): Promise<{ id: string }>;
  resolveSession(sessionId?: unknown): RunSession | undefined;
  sessionBusy(record: RunSession): boolean;
  sessionTerminalsRecord(sessionId: string, val: { termId: string }): Promise<void>;
  sessionTerminalsForget(sessionId: string): Promise<void>;
  upsertSessionMetadata(patch: Record<string, unknown>): void;
  listAllSessions(): Promise<Array<{ id: string; path?: string; name?: string }>>;
  listProvidersUnified(): Promise<unknown>;
  pushModelAuthToControlPlane(): Promise<unknown>;
  /** Pi's durable session index (runtimeHost.listSessions(getRuntime("pi"))). */
  listPiSessions(): Promise<unknown[]>;
  /** Which side owns this agent's auth ("agent" | "bivy" | "mixed"), from the
   *  unified agent-integration registry (#433). "agent" → no Bivy projection. */
  resolveAuthOwner(agent: string | undefined): string;
  broadcastTuiState(sessionId: string, active: boolean): void;
  refreshRecordAfterTui(record: RunSession): void;
  isEmptyUntitledTitle(name: string | undefined): boolean;
  getActiveSession(): { session?: { cwd?: string }; worktree?: { path?: string }; workspace?: string } | undefined;
  defaultWorkspace: string;
  credsDir: string;
  piDir: string;
  maxRunTerminals: number;
}

export interface RunTerminals {
  runTerminalList(): Promise<unknown[]>;
  openRunTerminal(spec: RunTerminalSpec, emit: (event: unknown) => void): Promise<string | undefined>;
  takeoverRunTerminal(opts: { termId?: string; sessionId?: string }): Promise<{ ok: true; sessionId: string; runtimeId: string; resumeCommand?: string } | { ok: false; status: number; error: string }>;
  handleTerminalMessage(msg: TerminalClientMessage, emit: (event: unknown) => void, owned: Set<string>, clientId: string, viewRun?: (termId: string) => void): boolean;
  addRunViewer(termId: string, socket: WebSocket): void;
  dropRunViewer(socket: WebSocket): void;
  hasRunTerminal(id: string): boolean;
}

type TerminalClientMessage = { kind?: string; termId?: unknown; data?: unknown; cols?: unknown; rows?: unknown; workspace?: unknown; sessionId?: unknown; agent?: unknown; label?: unknown; name?: unknown; model?: unknown; command?: unknown; args?: unknown; mux?: unknown; standalone?: unknown };

// Agents whose pinned run-terminal session can be reopened as a governed chat.
const TAKEOVER_RUNTIME_BY_AGENT: Record<string, string> = {
  claude: "claude-code-sdk",
  pi: "pi",
  codex: "codex-approvals",
  grok: "grok",
};
// The CLI command to continue an adopted session back in a terminal.
const RESUME_CLI_BY_AGENT: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  grok: (id) => `grok --resume ${id}`,
};
// When no resumable session id can be found, why — and what to do about it.
const TAKEOVER_EMPTY_HINT_BY_AGENT: Record<string, string> = {
  codex: "Codex writes its session only after the first message. Send one message in the terminal, then continue as chat.",
  pi: "Pi assigns its session once the conversation starts. Send one message in the terminal, then continue as chat.",
  grok: "Grok writes its session once the conversation starts. Send one message in the terminal, then continue as chat.",
};

/** Synthesize a default session name for a plain `bivy run` from agent + workspace. */
function defaultRunName(agent: string | undefined, commandLine: string, workspace: string): string {
  const base = agent || commandLine.split(/\s+/)[0] || "run";
  const folder = workspace.split("/").filter(Boolean).pop() || workspace;
  return `${base} · ${folder}`;
}

const ACTIVITY_PING_INTERVAL = 2000;
const IDLE_NOTIFY_INTERVAL = Number(process.env.BIVY_RUN_IDLE_NOTIFY_MS) || 30_000;
const BELL_QUIET_INPUT_MS = Number(process.env.BIVY_TERM_BELL_QUIET_MS) || 8_000;
const BELL_NOTIFY_COOLDOWN_MS = Number(process.env.BIVY_TERM_BELL_COOLDOWN_MS) || 45_000;

export function createRunTerminals(deps: RunTerminalDeps): RunTerminals {
  const { terminals } = deps;
  // Native agents' on-disk session, located by cwd + terminal start time for
  // agents that assign their id lazily (Codex/Pi/Grok).
  const SESSION_DISCOVERY_BY_AGENT: Record<string, (cwd: string, since: number) => string | undefined | Promise<string | undefined>> = {
    codex: (cwd, since) => discoverCodexSessionForCwd(cwd, since)?.id,
    pi: async (cwd, since) => {
      const match = discoverPiSessionForCwd(await deps.listPiSessions() as Parameters<typeof discoverPiSessionForCwd>[0], cwd, since) as { path?: string; id?: string } | undefined;
      return match?.path || match?.id;
    },
    grok: (cwd, since) => discoverGrokSessionForCwd(cwd, since)?.id,
  };

  const runTerminals = new Set<string>();
  const runViewers = new Map<string, Set<WebSocket>>();
  const lastActivityPing = new Map<string, number>();
  const runIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastBellNotify = new Map<string, number>();

  function hasRunTerminal(id: string): boolean {
    return runTerminals.has(id);
  }

  async function runTerminalList(): Promise<unknown[]> {
    const runs = terminals.list((meta) => meta.kind === "run").filter((t) => runTerminals.has(t.id));
    let saved: Array<{ id: string; path?: string; name?: string }> = [];
    if (runs.some((t) => t.meta.autoName)) {
      try { saved = await deps.listAllSessions(); } catch { /* best-effort listing */ }
    }
    const out = [];
    for (const t of runs) {
      let sessionRef = t.meta.sessionId;
      if (!sessionRef) {
        try { sessionRef = await SESSION_DISCOVERY_BY_AGENT[t.meta.agent ?? ""]?.(t.workspace, t.createdAt); }
        catch { /* agent may still be starting */ }
      }
      const native = sessionRef ? saved.find((s) => s.id === sessionRef || s.path === sessionRef) : undefined;
      const nativeName = native?.name?.trim();
      if (t.meta.autoName && nativeName && !deps.isEmptyUntitledTitle(nativeName)) t.meta.name = nativeName;
      const { autoName: _autoName, ...publicMeta } = t.meta;
      out.push({ termId: t.id, workspace: t.workspace, createdAt: t.createdAt, lastActivityAt: t.lastActivityAt, pid: terminals.pid(t.id), ...publicMeta, takeoverReady: Boolean(sessionRef) });
    }
    return out;
  }

  function broadcastRunTerminalList(): void {
    void runTerminalList().then((listed) => deps.broadcast({ type: "terminal.list", terminals: listed })).catch(() => {});
  }

  function armRunIdleNotify(id: string, displayName: string | undefined) {
    const existing = runIdleTimers.get(id);
    if (existing) clearTimeout(existing);
    runIdleTimers.set(id, setTimeout(() => {
      runIdleTimers.delete(id);
      if (!runTerminals.has(id)) return;
      deps.broadcast({ type: "terminal.idle", termId: id, at: Date.now() });
      broadcastRunTerminalList();
      const who = displayName || "An agent";
      deps.sendNotificationHint({ kind: "agent_waiting", title: `${who} is waiting`, body: `${who} has been quiet for a bit — it may be waiting for your input.` });
    }, IDLE_NOTIFY_INTERVAL));
  }

  function clearRunIdleNotify(id: string) {
    const t = runIdleTimers.get(id);
    if (t) { clearTimeout(t); runIdleTimers.delete(id); }
  }

  function maybeNotifyBell(id: string) {
    const now = Date.now();
    const lastInput = terminals.lastInput(id);
    if (lastInput != null && now - lastInput < BELL_QUIET_INPUT_MS) return;
    const lastNotify = lastBellNotify.get(id) ?? 0;
    if (now - lastNotify < BELL_NOTIFY_COOLDOWN_MS) return;
    lastBellNotify.set(id, now);
    const meta = terminals.meta(id);
    const who = meta?.name?.trim() || meta?.label?.trim() || "A terminal";
    deps.sendNotificationHint({ kind: "terminal_bell", title: "Terminal bell", body: `${who} rang the terminal bell — it may be waiting for you.` });
  }

  function clearBellNotify(id: string) {
    lastBellNotify.delete(id);
  }

  function addRunViewer(termId: string, socket: WebSocket) {
    let set = runViewers.get(termId);
    if (!set) { set = new Set(); runViewers.set(termId, set); }
    set.add(socket);
  }

  function dropRunViewer(socket: WebSocket) {
    for (const [id, set] of runViewers) {
      set.delete(socket);
      if (set.size === 0) runViewers.delete(id);
    }
  }

  function emitRunOutput(termId: string, data: string) {
    const viewers = runViewers.get(termId);
    if (viewers && viewers.size) {
      const payload = JSON.stringify({ type: "terminal.output", termId, data });
      for (const s of viewers) { if (s.readyState === 1 /* OPEN */) s.send(payload); }
    }
    deps.sendRelayEvent({ type: "terminal.output", termId, data });
  }

  function runTerminalForMux(target: string): string | undefined {
    if (!target) return undefined;
    for (const id of runTerminals) {
      if (terminals.meta(id)?.mux === target) return id;
    }
    return undefined;
  }

  async function openRunTerminal(spec: RunTerminalSpec, emit: (event: unknown) => void): Promise<string | undefined> {
    const label = spec.label ?? spec.agent;
    if (spec.mux) {
      const existing = runTerminalForMux(spec.mux);
      if (existing) {
        if (spec.clientId && (spec.cols !== undefined || spec.rows !== undefined)) terminals.setClientSize(existing, spec.clientId, spec.cols || 80, spec.rows || 24);
        emit({ type: "terminal.attached", termId: existing, data: terminals.snapshot(existing) ?? "" });
        return existing;
      }
    }
    if (Number.isFinite(deps.maxRunTerminals) && deps.maxRunTerminals > 0 && runTerminals.size >= deps.maxRunTerminals) {
      emit({ type: "terminal.error", error: `Too many run terminals open (${runTerminals.size}/${deps.maxRunTerminals}). Close one (e.g. 'bivy kill') or raise BIVY_MAX_RUN_TERMINALS.` });
      return undefined;
    }
    const active = deps.getActiveSession();
    const workspace = spec.workspace || active?.session?.cwd || active?.worktree?.path || active?.workspace || deps.defaultWorkspace;
    // Agent-owned integrations keep their native login untouched. Only an
    // integration that explicitly declares bivy/mixed auth receives projections
    // from Bivy's vault (#433). A mux attach always reuses its existing environment.
    const authOwner = deps.resolveAuthOwner(spec.agent);
    const credentialEnv = spec.mux || authOwner === "agent" ? {} : await provisionAgentRun(deps.credsDir, deps.piDir, spec.agent, workspace).catch((error) => {
      console.warn(`[provision] credential projection for "${spec.agent}" failed:`, (error as Error).message);
      return {};
    });
    const commandLine = [spec.command, ...spec.args].join(" ");
    const explicitName = spec.name?.trim();
    const name = explicitName || (spec.mux ? undefined : defaultRunName(spec.agent, commandLine, workspace));
    const notifiable = !spec.mux;
    const createdAt = Date.now();
    try {
      const id = terminals.open({
        workspace,
        command: spec.command,
        args: spec.args,
        env: credentialEnv,
        cols: spec.cols,
        rows: spec.rows,
        clientId: spec.clientId,
        meta: { kind: "run", agent: spec.agent, model: spec.model, label, name, autoName: !explicitName && !spec.mux, command: commandLine, mux: spec.mux, sessionId: spec.sessionId },
        onData: (data) => {
          emitRunOutput(id, data);
          const at = Date.now();
          if (at - (lastActivityPing.get(id) ?? 0) >= ACTIVITY_PING_INTERVAL) {
            lastActivityPing.set(id, at);
            deps.broadcast({ type: "terminal.activity", termId: id, at });
          }
          if (notifiable) armRunIdleNotify(id, name);
        },
        onExit: (code) => {
          runTerminals.delete(id);
          runViewers.delete(id);
          lastActivityPing.delete(id);
          clearRunIdleNotify(id);
          deps.broadcast({ type: "terminal.exit", termId: id, code });
          deps.broadcast({ type: "terminal.closed", termId: id });
          if (!spec.mux && spec.agent) {
            const agentId = spec.agent;
            void (async () => {
              let sessionRef = spec.sessionId;
              if (!sessionRef) {
                try { sessionRef = await SESSION_DISCOVERY_BY_AGENT[agentId]?.(workspace, createdAt); }
                catch { /* agent may never have written a session */ }
              }
              if (sessionRef) {
                const runtimeId = TAKEOVER_RUNTIME_BY_AGENT[agentId] ?? agentId;
                try { deps.upsertSessionMetadata({ id: sessionRef, runtimeId, agentName: agentId, workspace, name: name || undefined, source: "cli", status: "saved" }); }
                catch { /* best-effort */ }
              }
            })();
          }
          if (!spec.mux) {
            void ingestAgentCredentials(spec.agent, deps.credsDir, deps.piDir)
              .then(async (imported) => {
                if (imported > 0) {
                  deps.broadcast({ type: "providers.list", providers: await deps.listProvidersUnified() });
                  await deps.pushModelAuthToControlPlane();
                }
              })
              .catch(() => {});
          }
        },
      });
      runTerminals.add(id);
      if (spec.sessionId && spec.agent && !spec.mux) {
        const runtimeId = TAKEOVER_RUNTIME_BY_AGENT[spec.agent] ?? spec.agent;
        try { deps.upsertSessionMetadata({ id: spec.sessionId, runtimeId, agentName: spec.agent, workspace, name: name || undefined, source: "cli", status: "working" }); }
        catch { /* best-effort: a metadata write must never block the run launch */ }
      }
      emit({ type: "terminal.opened", termId: id, workspace, mode: "run", agent: spec.agent, label, name });
      deps.broadcast({ type: "terminal.created", terminal: { termId: id, workspace, createdAt, lastActivityAt: createdAt, kind: "run", agent: spec.agent, model: spec.model, label, name, command: commandLine, mux: spec.mux, sessionId: spec.sessionId, pid: terminals.pid(id) } });
      if (spec.sessionId && !spec.mux) {
        void deps.listAllSessions()
          .then((sessions) => deps.broadcast({ type: "sessions.list", sessions: sessions.map((s) => ({ ...s, sessionId: s.id })) }))
          .catch(() => {});
      }
      return id;
    } catch (error) {
      emit({ type: "terminal.error", workspace, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async function takeoverRunTerminal(opts: { termId?: string; sessionId?: string }): Promise<{ ok: true; sessionId: string; runtimeId: string; resumeCommand?: string } | { ok: false; status: number; error: string }> {
    const runs = terminals.list((m) => m.kind === "run").filter((t) => runTerminals.has(t.id));
    const entry = opts.termId
      ? runs.find((t) => t.id === opts.termId)
      : opts.sessionId
        ? runs.find((t) => t.meta.sessionId === opts.sessionId)
        : undefined;
    if (!entry) return { ok: false, status: 404, error: "No matching live run-terminal." };
    const agent = entry.meta.agent ?? "";
    const runtimeId = TAKEOVER_RUNTIME_BY_AGENT[agent];
    if (!runtimeId) return { ok: false, status: 409, error: `"Continue as chat" isn't supported for "${agent || "this agent"}" yet.` };
    const discovered = entry.meta.sessionId ? undefined : await SESSION_DISCOVERY_BY_AGENT[agent]?.(entry.workspace, entry.createdAt);
    const pinned = entry.meta.sessionId ?? discovered;
    if (!pinned) {
      const hint = TAKEOVER_EMPTY_HINT_BY_AGENT[agent] ?? `Start it via the shim (or \`bivy run\`), or continue it in a terminal.`;
      return { ok: false, status: 409, error: `Couldn't find a ${agent || "session"} session to continue yet. ${hint}` };
    }
    const workspace = entry.workspace;
    // 1. Stop the native TUI (the PTY this run-terminal owns is the kill target).
    terminals.close(entry.id);
    runTerminals.delete(entry.id);
    runViewers.delete(entry.id);
    deps.broadcast({ type: "terminal.closed", termId: entry.id });
    // 2. Reopen the session as a chat on its runtime.
    const record = await deps.createSession(workspace, pinned, { runtimeId, makeActive: true, source: "takeover" });
    const resumeCommand = RESUME_CLI_BY_AGENT[agent]?.(pinned);
    return { ok: true, sessionId: record.id, runtimeId, resumeCommand };
  }

  function handleTerminalMessage(msg: TerminalClientMessage, emit: (event: unknown) => void, owned: Set<string>, clientId: string, viewRun?: (termId: string) => void): boolean {
    switch (msg.kind) {
      case "terminal.list":
        void runTerminalList().then((listed) => emit({ type: "terminal.list", terminals: listed }));
        return true;
      case "terminal.takeover": {
        const takeoverTermId = typeof msg.termId === "string" && msg.termId ? msg.termId : undefined;
        const takeoverSessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined;
        void takeoverRunTerminal({ termId: takeoverTermId, sessionId: takeoverSessionId })
          .then((r) => r.ok
            ? emit({ type: "terminal.takeover.result", ok: true, termId: takeoverTermId, sessionId: r.sessionId, runtimeId: r.runtimeId, resumeCommand: r.resumeCommand })
            : emit({ type: "terminal.takeover.result", ok: false, termId: takeoverTermId, error: r.error }))
          .catch((error) => emit({ type: "terminal.takeover.result", ok: false, termId: takeoverTermId, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      case "terminal.multiplexers":
        void listMultiplexerSessions().then((sessions) => emit({ type: "multiplexer.list", sessions })).catch(() => emit({ type: "multiplexer.list", sessions: [] }));
        return true;
      case "terminal.open.run": {
        const command = typeof msg.command === "string" ? msg.command.trim() : "";
        if (!command) { emit({ type: "terminal.error", error: "terminal.open.run requires a command." }); return true; }
        void openRunTerminal({
          command,
          args: Array.isArray(msg.args) ? msg.args.map(String) : [],
          agent: typeof msg.agent === "string" ? msg.agent : undefined,
          label: typeof msg.label === "string" ? msg.label : undefined,
          name: typeof msg.name === "string" ? msg.name : undefined,
          model: typeof msg.model === "string" ? msg.model : undefined,
          mux: typeof msg.mux === "string" && msg.mux ? msg.mux : undefined,
          workspace: typeof msg.workspace === "string" && msg.workspace ? msg.workspace : undefined,
          cols: Number(msg.cols) || undefined,
          rows: Number(msg.rows) || undefined,
          clientId,
          sessionId: typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : undefined,
        }, emit).then((runId) => { if (runId) viewRun?.(runId); });
        return true;
      }
      case "terminal.open.mux": {
        const kind = String(msg.agent || "") as MultiplexerKind;
        const name = typeof msg.label === "string" ? msg.label : "";
        if (!["tmux", "zellij", "screen"].includes(kind) || !name) { emit({ type: "terminal.error", error: "terminal.open.mux requires a multiplexer and session name." }); return true; }
        const spec = attachCommand(kind, name);
        void openRunTerminal({ command: spec.command, args: spec.args, agent: kind, label: `${kind}:${name}`, mux: `${kind}:${name}`, cols: Number(msg.cols) || undefined, rows: Number(msg.rows) || undefined, clientId }, emit).then((muxId) => { if (muxId) viewRun?.(muxId); });
        return true;
      }
      case "terminal.open": {
        const standalone = Boolean(msg.standalone);
        const record = standalone ? undefined : deps.resolveSession(msg.sessionId);
        const active = deps.getActiveSession();
        const workspace = record
          ? (record.session.cwd || record.worktree?.path || record.workspace)
          : standalone
            ? deps.defaultWorkspace
            : (typeof msg.workspace === "string" && msg.workspace ? msg.workspace : (active?.session?.cwd || active?.worktree?.path || active?.workspace || deps.defaultWorkspace));
        try {
          const id = terminals.open({
            workspace,
            cols: Number(msg.cols) || undefined,
            rows: Number(msg.rows) || undefined,
            clientId,
            onData: (data) => emit({ type: "terminal.output", termId: id, data }),
            onBell: () => maybeNotifyBell(id),
            onExit: (code) => { owned.delete(id); clearBellNotify(id); emit({ type: "terminal.exit", termId: id, code }); },
          });
          owned.add(id);
          emit({ type: "terminal.opened", termId: id, workspace, sessionId: record?.id });
        } catch (error) {
          emit({ type: "terminal.error", workspace, sessionId: record?.id, error: error instanceof Error ? error.message : String(error) });
        }
        return true;
      }
      case "terminal.open.tui": {
        void (async () => {
          const record = deps.resolveSession(msg.sessionId);
          if (!record) { emit({ type: "terminal.error", error: "Session not found for TUI." }); return; }
          if (record.tuiTermId) {
            const snapshot = terminals.snapshot(record.tuiTermId);
            if (snapshot != null) {
              owned.add(record.tuiTermId);
              if (typeof msg.cols !== "undefined" || typeof msg.rows !== "undefined") terminals.setClientSize(record.tuiTermId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
              emit({ type: "terminal.attached", termId: record.tuiTermId, data: snapshot });
              return;
            }
          }
          if (deps.sessionBusy(record)) { emit({ type: "terminal.error", sessionId: record.id, error: "Finish or stop the current turn before opening the TUI." }); return; }
          let spec;
          try { spec = record.session.interactiveTuiCommand ? await record.session.interactiveTuiCommand() : null; }
          catch (error) { emit({ type: "terminal.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) }); return; }
          if (!spec) { emit({ type: "terminal.error", sessionId: record.id, error: "This runtime has no interactive TUI available on this node." }); return; }
          const workspace = record.session.cwd || record.worktree?.path || record.workspace;
          try {
            const id = terminals.open({
              workspace,
              command: spec.command,
              args: spec.args,
              env: spec.env,
              cols: Number(msg.cols) || undefined,
              rows: Number(msg.rows) || undefined,
              clientId,
              onData: (data) => emit({ type: "terminal.output", termId: id, data }),
              onExit: (code) => {
                owned.delete(id);
                if (record.tuiTermId === id) {
                  record.tuiTermId = undefined;
                  void deps.sessionTerminalsForget(record.id).catch(() => {});
                  record.tuiRefreshing = true;
                  deps.broadcastTuiState(record.id, false);
                  void deps.refreshRecordAfterTui(record);
                }
                emit({ type: "terminal.exit", termId: id, code });
              },
            });
            owned.add(id);
            record.tuiTermId = id;
            void deps.sessionTerminalsRecord(record.id, { termId: id }).catch(() => {});
            emit({ type: "terminal.opened", termId: id, workspace, sessionId: record.id, mode: "tui" });
            deps.broadcastTuiState(record.id, true);
          } catch (error) {
            emit({ type: "terminal.error", sessionId: record.id, error: error instanceof Error ? error.message : String(error) });
          }
        })();
        return true;
      }
      case "terminal.close.tui": {
        const record = deps.resolveSession(msg.sessionId);
        const termId = record?.tuiTermId;
        if (termId) {
          terminals.close(termId);
          owned.delete(termId);
          clearBellNotify(termId);
        } else if (record) {
          deps.broadcastTuiState(record.id, false);
        }
        return true;
      }
      case "terminal.attach": {
        if (typeof msg.termId === "string") {
          const snapshot = terminals.snapshot(msg.termId);
          if (snapshot != null) {
            if (viewRun && runTerminals.has(msg.termId)) viewRun(msg.termId);
            else owned.add(msg.termId);
            if (typeof msg.cols !== "undefined" || typeof msg.rows !== "undefined") terminals.setClientSize(msg.termId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
            emit({ type: "terminal.attached", termId: msg.termId, data: snapshot });
          } else {
            emit({ type: "terminal.gone", termId: msg.termId });
          }
        }
        return true;
      }
      case "terminal.input":
        if (typeof msg.termId === "string" && typeof msg.data === "string") terminals.write(msg.termId, msg.data);
        return true;
      case "terminal.resize":
        if (typeof msg.termId === "string") terminals.setClientSize(msg.termId, clientId, Number(msg.cols) || 80, Number(msg.rows) || 24);
        return true;
      case "terminal.detach":
        if (typeof msg.termId === "string") terminals.dropClientSize(msg.termId, clientId);
        return true;
      case "terminal.close":
        if (typeof msg.termId === "string") { terminals.close(msg.termId); owned.delete(msg.termId); clearBellNotify(msg.termId); }
        return true;
      default:
        return false;
    }
  }

  return { runTerminalList, openRunTerminal, takeoverRunTerminal, handleTerminalMessage, addRunViewer, dropRunViewer, hasRunTerminal };
}
