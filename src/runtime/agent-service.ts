// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Agent service — the service-side half of Stage 1
 * (docs/agent-node-decoupling.md). It hosts the REAL runtime (claude-code.ts /
 * process.ts / protocol.ts) in its own process, spawning the agent child
 * locally to ITSELF, and exposes it to the node daemon over the RPC protocol
 * (src/runtime/rpc-protocol.ts). This is what breaks the `ppid = daemon`
 * coupling: the agent child is now a child of the service, not the daemon.
 *
 * Lifecycle / disconnect policy: sessions live in a registry that SURVIVES a
 * connection drop. An explicit `dispose` notify reaps the child and drops the
 * session; an unexpected disconnect DETACHES (keeps the child running) so a
 * reconnecting daemon can `attach` and resume — the "detach & keep running"
 * policy. The service always reaps every child on its own shutdown, so it never
 * leaks orphans of its own.
 *
 * The core is transport-agnostic (it takes a `ServiceConnection`), so it drives
 * from a fake in unit tests and from a real socket in the bin / integration
 * test. The runtime is provided via an injected factory, so tests substitute a
 * tiny echo runtime for the real (claude/CLI) ones.
 */

import type {
  ClientMessage,
  EventMessage,
  InitialSnapshot,
  PartialSnapshot,
  ServerMessage,
} from "./rpc-protocol.js";
import { RPC_PROTOCOL_VERSION } from "./rpc-protocol.js";
import type {
  AgentRuntime,
  ModelInfo,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  ToolCallDecision,
  ToolInterceptor,
  ToolProvider,
  ToolResult,
  ToolSpec,
} from "./types.js";

/** One live connection to a daemon, reversed relative to RemoteRuntime's transport. */
export interface ServiceConnection {
  send(message: ServerMessage): void;
  onMessage(handler: (message: ClientMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Builds the real runtime the service should host for a given id/sandbox. */
export type RuntimeProvider = (runtimeId: string, sandbox?: string) => AgentRuntime;

/** Injectable one-shot timer, so the idle-reaper unit-tests without real time
 *  (mirrors session-event-coalescer.ts's CoalescerTimers). */
export interface ReaperTimers<H = ReturnType<typeof setTimeout>> {
  schedule: (fn: () => void, ms: number) => H;
  cancel: (handle: H) => void;
}

const defaultReaperTimers: ReaperTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h),
};

export interface AgentServiceOptions<H = ReturnType<typeof setTimeout>> {
  runtimeProvider: RuntimeProvider;
  log?: (message: string) => void;
  /**
   * Idle-reaper TTL for DETACHED sessions (Stage 3, docs/agent-node-decoupling.md).
   * Under the "detach & keep running" policy a session the daemon evicts/loses
   * persists here forever; this bounds that. A session with no bound daemon
   * connection that has been idle (not streaming) for this many ms is reaped.
   * 0 / undefined disables the reaper (the default — off unless configured).
   */
  detachReapMs?: number;
  /** Injectable timer for the reaper sweep (tests). */
  timers?: ReaperTimers<H>;
  /** Injectable clock for the reaper (tests); defaults to Date.now. */
  now?: () => number;
}

/** The cheap scalar mirror the service diffs to build snapshot deltas. */
interface MirrorState {
  isStreaming: boolean;
  sessionFile: string | undefined;
  name: string | undefined;
  currentModelKey: string;
  activePid: number | undefined;
  thinkingLevel: string | undefined;
  messageCount: number;
}

interface ServiceSession {
  id: string;
  runtime: AgentRuntime;
  session: RuntimeSession;
  unsubscribe: () => void;
  conn: ServiceConnection | null;
  interceptSeq: number;
  pendingIntercepts: Map<number, (decision: ToolCallDecision) => void>;
  /** In-flight node-hosted tool executions awaiting the daemon's `tool-invoke-res`. */
  invokeSeq: number;
  pendingInvokes: Map<number, (result: ToolResult) => void>;
  lastSent: MirrorState;
  disposed: boolean;
  /** Wall-clock of the last activity (create/attach/forwarded event, and the
   *  moment of detach) — the idle-reaper's anchor for a detached session. */
  lastActiveAt: number;
}

function modelKey(model: ModelInfo | undefined): string {
  return model ? `${model.provider}:${model.id}` : "";
}

export class AgentService<H = ReturnType<typeof setTimeout>> {
  private readonly runtimeProvider: RuntimeProvider;
  private readonly log: (message: string) => void;
  private readonly sessions = new Map<string, ServiceSession>();
  private readonly binding = new Map<ServiceConnection, ServiceSession>();
  private readonly detachReapMs: number;
  private readonly timers: ReaperTimers<H>;
  private readonly now: () => number;
  private sweepHandle: H | undefined;

  constructor(options: AgentServiceOptions<H>) {
    this.runtimeProvider = options.runtimeProvider;
    this.log = options.log ?? (() => {});
    this.detachReapMs = options.detachReapMs && options.detachReapMs > 0 ? options.detachReapMs : 0;
    this.timers = options.timers ?? (defaultReaperTimers as unknown as ReaperTimers<H>);
    this.now = options.now ?? (() => Date.now());
    if (this.detachReapMs) this.armSweep();
  }

  /** Number of live (non-disposed) sessions — test/introspection aid. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Attach the service to a new daemon connection. */
  accept(conn: ServiceConnection): void {
    conn.onMessage((message) => {
      void this.dispatch(conn, message).catch((error) => {
        this.log(`agent-service dispatch error: ${error instanceof Error ? error.stack : String(error)}`);
      });
    });
    conn.onClose(() => this.handleConnClose(conn));
  }

  /** Reap every session (service shutdown). */
  disposeAll(): void {
    if (this.sweepHandle !== undefined) {
      this.timers.cancel(this.sweepHandle);
      this.sweepHandle = undefined;
    }
    for (const svc of [...this.sessions.values()]) this.reap(svc);
  }

  // ---- idle-reaper (detached sessions) --------------------------------------

  /** Schedule the next sweep at ~half the TTL, so worst-case overshoot is bounded. */
  private armSweep(): void {
    if (!this.detachReapMs) return;
    this.sweepHandle = this.timers.schedule(() => this.sweep(), Math.max(1, Math.floor(this.detachReapMs / 2)));
  }

  /**
   * Reap sessions that have been DETACHED (no bound daemon connection) and IDLE
   * (not currently streaming) for at least the TTL. Never touches an attached or
   * streaming session — a live turn keeps running. Public for tests; also re-arms.
   */
  sweep(): void {
    if (!this.detachReapMs) return;
    const now = this.now();
    for (const svc of [...this.sessions.values()]) {
      if (svc.disposed || svc.conn) continue; // attached → keep
      if (svc.session?.isStreaming) continue; // mid-turn → keep (don't kill a live turn)
      if (now - svc.lastActiveAt >= this.detachReapMs) {
        this.log(`agent-service reaping detached idle session ${svc.id} (idle ${Math.round((now - svc.lastActiveAt) / 1000)}s)`);
        this.reap(svc);
      }
    }
    this.armSweep();
  }

  private async dispatch(conn: ServiceConnection, message: ClientMessage): Promise<void> {
    switch (message.t) {
      case "start":
        return this.handleStart(conn, message);
      case "rt":
        return this.handleRuntimeCall(conn, message);
      case "req":
        return this.handleRequest(conn, message);
      case "notify":
        return this.handleNotify(conn, message);
      case "intercept-res":
        return this.handleInterceptResult(conn, message);
      case "tool-invoke-res":
        return this.handleToolInvokeResult(conn, message);
    }
  }

  // ---- start / attach -------------------------------------------------------

  private async handleStart(conn: ServiceConnection, message: Extract<ClientMessage, { t: "start" }>): Promise<void> {
    if (message.protocol !== RPC_PROTOCOL_VERSION) {
      conn.send({ t: "res", id: message.id, ok: false, error: `Unsupported RPC protocol ${message.protocol} (service speaks ${RPC_PROTOCOL_VERSION})` });
      return;
    }
    try {
      if (message.op === "attach") {
        const existing = message.options.sessionId ? this.sessions.get(message.options.sessionId) : undefined;
        if (!existing || existing.disposed) throw new Error(`No detached session to attach: ${message.options.sessionId}`);
        // Re-bind: detach any stale connection, resync full state, resume forwarding.
        existing.conn = conn;
        existing.pendingIntercepts.clear();
        existing.pendingInvokes.clear();
        existing.lastActiveAt = this.now(); // re-attach counts as activity
        this.binding.set(conn, existing);
        existing.lastSent = this.mirror(existing.session);
        conn.send({ t: "started", id: message.id, snapshot: this.initialSnapshot(existing) });
        return;
      }

      const runtime = this.runtimeProvider(message.runtime, message.sandbox);
      // Shell first so the interceptor closure can reference the not-yet-built session.
      const svc: ServiceSession = {
        id: "",
        runtime,
        session: undefined as unknown as RuntimeSession,
        unsubscribe: () => {},
        conn,
        interceptSeq: 1,
        pendingIntercepts: new Map(),
        invokeSeq: 1,
        pendingInvokes: new Map(),
        lastSent: undefined as unknown as MirrorState,
        disposed: false,
        lastActiveAt: this.now(),
      };
      const toolInterceptor = message.options.hasToolInterceptor ? this.makeInterceptor(svc) : undefined;
      // Reconstruct a proxy ToolProvider from the specs the daemon sent, so the
      // hosted runtime gets the tools while each call routes back to the daemon.
      const toolProvider = message.options.toolSpecs?.length ? this.makeToolProvider(svc, message.options.toolSpecs) : undefined;
      const workspace = message.options.workspace ?? process.cwd();
      const result =
        message.op === "open" && message.options.sessionFile
          ? await runtime.openSession({ workspace, sessionFile: message.options.sessionFile, toolInterceptor, toolProvider })
          : await runtime.createSession({ workspace, toolInterceptor, toolProvider });

      svc.session = result.session;
      svc.id = result.session.id;
      svc.lastSent = this.mirror(result.session);
      this.sessions.set(svc.id, svc);
      this.binding.set(conn, svc);
      svc.unsubscribe = result.session.subscribe((event) => this.forward(svc, event));

      const snapshot = this.initialSnapshot(svc);
      if (result.warning) snapshot.warning = result.warning;
      conn.send({ t: "started", id: message.id, snapshot });
    } catch (error) {
      conn.send({ t: "res", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- session-less runtime calls ------------------------------------------

  private async handleRuntimeCall(conn: ServiceConnection, message: Extract<ClientMessage, { t: "rt" }>): Promise<void> {
    if (message.protocol !== RPC_PROTOCOL_VERSION) {
      conn.send({ t: "res", id: message.id, ok: false, error: `Unsupported RPC protocol ${message.protocol}` });
      return;
    }
    try {
      const runtime = this.runtimeProvider(message.runtime, message.sandbox);
      let value: unknown;
      if (message.method === "listSessions") {
        value = await runtime.listSessions();
      } else if (message.method === "deleteSession") {
        value = (await runtime.deleteSession?.(message.args[0] as string, message.args[1] as string | undefined)) ?? false;
      }
      conn.send({ t: "res", id: message.id, ok: true, value });
    } catch (error) {
      conn.send({ t: "res", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- per-session method dispatch -----------------------------------------

  private async handleRequest(conn: ServiceConnection, message: Extract<ClientMessage, { t: "req" }>): Promise<void> {
    const svc = this.binding.get(conn);
    if (!svc) {
      conn.send({ t: "res", id: message.id, ok: false, error: "No session bound to this connection" });
      return;
    }
    const s = svc.session;
    const [a0, a1] = message.args;
    try {
      let value: unknown;
      let snapshot: PartialSnapshot | undefined;
      switch (message.method) {
        case "prompt":
          await s.prompt(a0 as string, a1 as never);
          break;
        case "abort":
          await s.abort();
          break;
        case "setModel":
          await s.setModel(a0 as string, a1 as string);
          snapshot = { currentModel: s.getCurrentModel() ?? null };
          break;
        case "getModels":
          value = await s.getModels();
          break;
        case "getAllModels":
          value = (await s.getAllModels?.()) ?? [];
          break;
        case "warmModels":
          await s.warmModels?.();
          break;
        case "getUsage":
          value = (await s.getUsage?.()) ?? undefined;
          break;
        case "suggestName":
          value = await s.suggestName(a0 as string);
          break;
        case "invokeCommand":
          await s.invokeCommand?.(a0 as string, a1 as string);
          break;
        case "interactiveTuiCommand":
          value = (await s.interactiveTuiCommand?.()) ?? null;
          break;
      }
      conn.send({ t: "res", id: message.id, ok: true, value, snapshot });
    } catch (error) {
      conn.send({ t: "res", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleNotify(conn: ServiceConnection, message: Extract<ClientMessage, { t: "notify" }>): void {
    const svc = this.binding.get(conn);
    if (!svc) return;
    if (message.method === "dispose") {
      this.reap(svc);
      return;
    }
    try {
      if (message.method === "setName") svc.session.setName(message.args[0] as string);
      else if (message.method === "setThinkingLevel") svc.session.setThinkingLevel?.(message.args[0] as string);
    } catch (error) {
      this.log(`agent-service notify ${message.method} error: ${String(error)}`);
    }
  }

  private handleInterceptResult(conn: ServiceConnection, message: Extract<ClientMessage, { t: "intercept-res" }>): void {
    const svc = this.binding.get(conn);
    const resolve = svc?.pendingIntercepts.get(message.id);
    if (svc && resolve) {
      svc.pendingIntercepts.delete(message.id);
      resolve(message.decision);
    }
  }

  private handleToolInvokeResult(conn: ServiceConnection, message: Extract<ClientMessage, { t: "tool-invoke-res" }>): void {
    const svc = this.binding.get(conn);
    const resolve = svc?.pendingInvokes.get(message.id);
    if (svc && resolve) {
      svc.pendingInvokes.delete(message.id);
      resolve(message.result);
    }
  }

  // ---- tool interception (reverse RPC to the daemon) ------------------------

  private makeInterceptor(svc: ServiceSession): ToolInterceptor {
    return (ctx) => {
      const conn = svc.conn;
      // Detached (daemon gone): never run an unapproved tool.
      if (!conn) return { block: true, reason: "agent daemon disconnected" };
      return new Promise<ToolCallDecision>((resolve) => {
        const id = svc.interceptSeq++;
        svc.pendingIntercepts.set(id, resolve);
        // If the turn aborts service-side, settle immediately so nothing hangs.
        ctx.signal?.addEventListener(
          "abort",
          () => {
            if (svc.pendingIntercepts.delete(id)) resolve({});
          },
          { once: true },
        );
        conn.send({ t: "intercept", id, ctx: { sessionId: ctx.sessionId, toolName: ctx.toolName, input: ctx.input } });
      });
    };
  }

  // ---- node-hosted tools (reverse RPC to the daemon) ------------------------

  /**
   * Build a proxy ToolProvider from the specs the daemon sent. `list()` returns
   * those specs (so the hosted runtime registers the tools); `invoke()` forwards
   * the call to the daemon as a `tool-invoke` and resolves on its
   * `tool-invoke-res`, so the tool executes on the daemon where its credentials
   * live — the same reverse-RPC shape the guardian uses.
   */
  private makeToolProvider(svc: ServiceSession, specs: ToolSpec[]): ToolProvider {
    return {
      list: () => specs,
      invoke: (toolName, toolCallId, params, signal) => {
        const conn = svc.conn;
        // Detached (daemon gone): can't run a tool whose implementation lives there.
        if (!conn) return Promise.resolve({ content: [{ type: "text", text: "agent daemon disconnected" }], isError: true });
        return new Promise<ToolResult>((resolve) => {
          const id = svc.invokeSeq++;
          svc.pendingInvokes.set(id, resolve);
          // If the turn aborts service-side, settle immediately so nothing hangs.
          signal?.addEventListener(
            "abort",
            () => {
              if (svc.pendingInvokes.delete(id)) resolve({ content: [{ type: "text", text: "aborted" }], isError: true });
            },
            { once: true },
          );
          conn.send({ t: "tool-invoke", id, sessionId: svc.id, toolName, toolCallId, params });
        });
      },
    };
  }

  // ---- event forwarding + snapshots ----------------------------------------

  private forward(svc: ServiceSession, event: RuntimeEvent): void {
    svc.lastActiveAt = this.now(); // any runtime event is activity (reaper anchor)
    const conn = svc.conn;
    if (!conn) return; // detached: the daemon re-syncs full state on attach
    // agent_end is the boundary the daemon's post-turn logic reads (usage
    // refresh, worktree diff, PR detection). Force the authoritative post-turn
    // state onto that frame so the mirror is correct even for a runtime that
    // mutates messages/sessionFile exactly at agent_end (no prior message_end
    // delta) — the "set before agent_end" invariant in process.ts.
    const authoritative = event.type === "agent_end";
    const snapshot = this.snapshotDelta(svc, authoritative);
    const message: EventMessage = snapshot ? { t: "event", event, snapshot } : { t: "event", event };
    conn.send(message);
  }

  private mirror(session: RuntimeSession): MirrorState {
    return {
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      name: session.getName(),
      currentModelKey: modelKey(session.getCurrentModel()),
      activePid: session.activePid?.(),
      thinkingLevel: session.getThinkingLevel?.(),
      messageCount: session.getMessages().length,
    };
  }

  /**
   * Diff the current session state against lastSent; return only what changed.
   * When `authoritative`, force the post-turn fields (isStreaming/sessionFile/
   * activePid/messages) into the delta even if unchanged, so the caller can
   * guarantee the agent_end frame carries them.
   */
  private snapshotDelta(svc: ServiceSession, authoritative = false): PartialSnapshot | undefined {
    const s = svc.session;
    const now = this.mirror(s);
    const prev = svc.lastSent;
    const delta: PartialSnapshot = {};
    let changed = false;
    if (authoritative || now.isStreaming !== prev.isStreaming) { delta.isStreaming = now.isStreaming; changed = true; }
    if (authoritative || now.sessionFile !== prev.sessionFile) { delta.sessionFile = now.sessionFile ?? null; changed = true; }
    if (now.name !== prev.name) { delta.name = now.name ?? null; changed = true; }
    if (now.currentModelKey !== prev.currentModelKey) { delta.currentModel = s.getCurrentModel() ?? null; changed = true; }
    if (authoritative || now.activePid !== prev.activePid) { delta.activePid = now.activePid ?? null; changed = true; }
    if (now.thinkingLevel !== prev.thinkingLevel) { delta.thinkingLevel = now.thinkingLevel ?? null; changed = true; }
    if (authoritative || now.messageCount !== prev.messageCount) { delta.messages = s.getMessages() as RuntimeMessage[]; changed = true; }
    svc.lastSent = now;
    return changed ? delta : undefined;
  }

  private initialSnapshot(svc: ServiceSession): InitialSnapshot {
    const s = svc.session;
    return {
      sessionId: s.id,
      cwd: s.cwd,
      isStreaming: s.isStreaming,
      sessionFile: s.sessionFile ?? null,
      name: s.getName() ?? null,
      currentModel: s.getCurrentModel() ?? null,
      activePid: s.activePid?.() ?? null,
      thinkingLevel: s.getThinkingLevel?.() ?? null,
      messages: s.getMessages() as RuntimeMessage[],
      capabilities: svc.runtime.capabilities,
      supportsThinking: s.supportsThinking?.() ?? false,
      availableThinkingLevels: s.getAvailableThinkingLevels?.() ?? [],
      commands: s.getCommands?.() ?? [],
    };
  }

  // ---- teardown -------------------------------------------------------------

  private handleConnClose(conn: ServiceConnection): void {
    const svc = this.binding.get(conn);
    this.binding.delete(conn);
    if (!svc || svc.disposed) return;
    if (svc.conn !== conn) return; // a newer connection already took over
    // Detach: keep the child running, deny any tool waiting on the vanished daemon.
    svc.conn = null;
    svc.lastActiveAt = this.now(); // start the idle-reaper clock from the detach
    for (const resolve of svc.pendingIntercepts.values()) resolve({ block: true, reason: "agent daemon disconnected" });
    svc.pendingIntercepts.clear();
    for (const resolve of svc.pendingInvokes.values()) resolve({ content: [{ type: "text", text: "agent daemon disconnected" }], isError: true });
    svc.pendingInvokes.clear();
    this.log(`agent-service session ${svc.id} detached (kept running)`);
  }

  private reap(svc: ServiceSession): void {
    if (svc.disposed) return;
    svc.disposed = true;
    for (const resolve of svc.pendingIntercepts.values()) resolve({ block: true, reason: "session disposed" });
    svc.pendingIntercepts.clear();
    for (const resolve of svc.pendingInvokes.values()) resolve({ content: [{ type: "text", text: "session disposed" }], isError: true });
    svc.pendingInvokes.clear();
    try {
      svc.unsubscribe();
    } catch {
      // ignore
    }
    try {
      svc.session?.dispose();
    } catch (error) {
      this.log(`agent-service dispose error for ${svc.id}: ${String(error)}`);
    }
    if (svc.conn) this.binding.delete(svc.conn);
    this.sessions.delete(svc.id);
  }
}
