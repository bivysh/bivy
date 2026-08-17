// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Remote runtime adapter — the daemon-side half of Stage 1
 * (docs/agent-node-decoupling.md). `RemoteRuntimeSession implements
 * RuntimeSession` but owns no child process: it speaks the RPC protocol
 * (src/runtime/rpc-protocol.ts) to an agent service that hosts the real runtime
 * in another process. Because it satisfies the same `RuntimeSession` interface,
 * server.ts's ~40 `openSessions` call sites are untouched — the seam is
 * `RuntimeHost.get()` returning a `RemoteRuntime` instead of an in-process one.
 *
 * Two design points make this a faithful drop-in:
 *  - The synchronous accessors the daemon reads (getMessages/getName/
 *    getCurrentModel/isStreaming/sessionFile/activePid/…) cannot round-trip, so
 *    they read a LOCAL MIRROR the service keeps current via snapshot deltas that
 *    ride each event. The mutated fields land on the SAME frame as `agent_end`,
 *    so the mirror is correct at the boundary the daemon's post-turn logic reads
 *    (usage refresh, worktree diff, PR detection) — matching process.ts timing.
 *  - The tool interceptor (the guardian/QuestionManager hook) stays on the
 *    daemon. The service asks the daemon to adjudicate each tool via a reverse
 *    RPC (`intercept`), so AskUserQuestion is answered by the daemon exactly as
 *    in-process and no `user_question` event ever crosses this link.
 *
 * The concrete socket transport lives here too, but the session/runtime take an
 * injected `RpcTransport`, so they unit-test against a fake (see the tests).
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import {
  RPC_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  type ClientMessage,
  type InitialSnapshot,
  type PartialSnapshot,
  type RpcMethod,
  type RuntimeRpcMethod,
  type ServerMessage,
  type StartOp,
  type StartOptions,
} from "./rpc-protocol.js";
import type {
  AgentCommand,
  AgentRuntime,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  PromptOptions,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolCallContext,
  ToolCallDecision,
  ToolInterceptor,
  ToolProvider,
  ToolResult,
  TuiLaunchSpec,
  UsageSnapshot,
} from "./types.js";

/**
 * The minimal duplex the remote session needs. Kept structural (no `net`
 * dependency) so the session and runtime unit-test against a fake, mirroring the
 * injectable pattern in backpressure.ts / session-event-coalescer.ts.
 */
export interface RpcTransport {
  send(message: ClientMessage): void;
  /** Register the single inbound-message sink. The last registration wins. */
  onMessage(handler: (message: ServerMessage) => void): void;
  /** Register the close sink; `err` is set on an abnormal close. */
  onClose(handler: (err?: Error) => void): void;
  close(): void;
}

/**
 * Bound every daemon → agent-service round-trip so a slow, unreachable, or
 * restarting service fails fast instead of stalling on the OS socket timeout
 * (tens of seconds). A blocked handshake here is exactly what made opening an
 * "active" cloud session take upward of 10s: `startRemoteSession` awaited the
 * `started` frame, `connectSocketTransport` awaited `connect`, and `runtimeCall`
 * awaited a `res` — none with a deadline. All three are overridable for slow
 * links / tests.
 */
const REMOTE_CONNECT_TIMEOUT_MS = Number(process.env.BIVY_REMOTE_CONNECT_TIMEOUT_MS ?? 8_000);
const REMOTE_HANDSHAKE_TIMEOUT_MS = Number(process.env.BIVY_REMOTE_HANDSHAKE_TIMEOUT_MS ?? 15_000);
const REMOTE_RPC_TIMEOUT_MS = Number(process.env.BIVY_REMOTE_RPC_TIMEOUT_MS ?? 10_000);

/** Log a remote round-trip that crossed the slow threshold, so the 10s cases are
 *  visible in the daemon log without drowning healthy sub-second opens. */
const REMOTE_SLOW_LOG_MS = Number(process.env.BIVY_REMOTE_SLOW_LOG_MS ?? 1_000);
function logRemoteTiming(op: string, startedMs: number, extra?: string): void {
  const elapsed = Date.now() - startedMs;
  if (elapsed >= REMOTE_SLOW_LOG_MS) {
    console.warn(`[remote] slow ${op}: ${elapsed}ms${extra ? ` ${extra}` : ""}`);
  }
}

interface RemoteSessionOptions {
  toolInterceptor?: ToolInterceptor;
  /**
   * The daemon-side implementation of this session's node-hosted tools. The
   * service runs the agent and forwards each tool call back as a `tool-invoke`;
   * this provider executes it here (where the credentials live) and returns the
   * result. Its specs were sent in `start` so the service could register them.
   */
  toolProvider?: ToolProvider;
  /** Called once the session is torn down (disposed or its link dropped). */
  onDispose?: () => void;
}

/** A RuntimeSession backed by an agent service over an RpcTransport. */
export class RemoteRuntimeSession implements RuntimeSession {
  readonly id: string;
  readonly cwd: string;

  private readonly emitter = new EventEmitter();
  private readonly transport: RpcTransport;
  private readonly toolInterceptor?: ToolInterceptor;
  private readonly toolProvider?: ToolProvider;
  private readonly onDispose?: () => void;

  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** In-flight interceptor calls, so abort() can settle a blocked question card. */
  private readonly interceptAborts = new Map<number, AbortController>();
  private disposed = false;

  // ---- Mirror of the synchronous RuntimeSession state ----------------------
  private _sessionFile?: string;
  private _isStreaming: boolean;
  private _name?: string;
  private _currentModel?: ModelInfo;
  private _activePid?: number;
  private _thinkingLevel?: string;
  private _messages: RuntimeMessage[];
  private readonly _supportsThinking: boolean;
  private readonly _availableThinkingLevels: string[];
  private _commands: AgentCommand[];

  constructor(transport: RpcTransport, snapshot: InitialSnapshot, options: RemoteSessionOptions = {}) {
    this.transport = transport;
    this.toolInterceptor = options.toolInterceptor;
    this.toolProvider = options.toolProvider;
    this.onDispose = options.onDispose;
    this.id = snapshot.sessionId;
    this.cwd = snapshot.cwd;
    this._sessionFile = snapshot.sessionFile ?? undefined;
    this._isStreaming = snapshot.isStreaming;
    this._name = snapshot.name ?? undefined;
    this._currentModel = snapshot.currentModel ?? undefined;
    this._activePid = snapshot.activePid ?? undefined;
    this._thinkingLevel = snapshot.thinkingLevel ?? undefined;
    this._messages = snapshot.messages ?? [];
    this._supportsThinking = snapshot.supportsThinking;
    this._availableThinkingLevels = snapshot.availableThinkingLevels ?? [];
    this._commands = snapshot.commands ?? [];
  }

  // ---- Inbound wiring (driven by the transport owner) -----------------------

  /** Apply one service→daemon message. Public so the connector can route it. */
  handleMessage(message: ServerMessage): void {
    switch (message.t) {
      case "event":
        if (message.snapshot) this.applySnapshot(message.snapshot);
        this.emitter.emit("event", message.event);
        return;
      case "state":
        this.applySnapshot(message.snapshot);
        return;
      case "res": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) {
          if (message.snapshot) this.applySnapshot(message.snapshot);
          entry.resolve(message.value);
        } else {
          entry.reject(new Error(message.error));
        }
        return;
      }
      case "intercept":
        void this.handleIntercept(message.id, message.ctx);
        return;
      case "tool-invoke":
        void this.handleToolInvoke(message.id, message.toolName, message.toolCallId, message.params);
        return;
      case "started":
        // Late/duplicate handshake reply — the connector already consumed it.
        return;
    }
  }

  /** Called when the underlying link closes. Fails a live turn cleanly. */
  handleClose(err?: Error): void {
    if (this.disposed) return;
    const error = err ?? new Error("agent service connection closed");
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const controller of this.interceptAborts.values()) controller.abort();
    this.interceptAborts.clear();
    // If a turn was live, surface an error + close it so the daemon's busy
    // tracking and post-turn logic don't hang waiting for an agent_end.
    if (this._isStreaming) {
      this._isStreaming = false;
      this._activePid = undefined;
      this.emitter.emit("event", { type: "session.error", error: error.message });
      this.emitter.emit("event", { type: "agent_end", code: null, signal: null, disconnected: true });
    }
  }

  private applySnapshot(s: PartialSnapshot): void {
    if (s.isStreaming !== undefined) this._isStreaming = s.isStreaming;
    if (s.sessionFile !== undefined) this._sessionFile = s.sessionFile ?? undefined;
    if (s.name !== undefined) this._name = s.name ?? undefined;
    if (s.currentModel !== undefined) this._currentModel = s.currentModel ?? undefined;
    if (s.activePid !== undefined) this._activePid = s.activePid ?? undefined;
    if (s.thinkingLevel !== undefined) this._thinkingLevel = s.thinkingLevel ?? undefined;
    if (s.messages !== undefined) this._messages = s.messages;
  }

  private async handleIntercept(id: number, ctx: { sessionId: string; toolName: string; input: unknown }): Promise<void> {
    const controller = new AbortController();
    this.interceptAborts.set(id, controller);
    let decision: ToolCallDecision = {};
    try {
      if (this.toolInterceptor) {
        const call: ToolCallContext = { sessionId: ctx.sessionId, toolName: ctx.toolName, input: ctx.input, signal: controller.signal };
        decision = (await this.toolInterceptor(call)) || {};
      }
    } catch (error) {
      decision = { block: true, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.interceptAborts.delete(id);
    }
    if (!this.disposed) this.transport.send({ t: "intercept-res", id, decision });
  }

  /**
   * Execute a node-hosted tool the remote agent invoked (reverse RPC). The tool
   * runs HERE on the daemon via the injected ToolProvider — where its credentials
   * live — and the result goes back to the service, which hands it to the agent.
   */
  private async handleToolInvoke(id: number, toolName: string, toolCallId: string, params: unknown): Promise<void> {
    let result: ToolResult;
    try {
      result = this.toolProvider
        ? await this.toolProvider.invoke(toolName, toolCallId, params)
        : { content: [{ type: "text", text: `No tool provider for ${toolName}` }], isError: true };
    } catch (error) {
      result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
    if (!this.disposed) this.transport.send({ t: "tool-invoke-res", id, result });
  }

  // ---- Request/response helpers --------------------------------------------

  private request<T>(method: RpcMethod, args: unknown[]): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("session disposed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send({ t: "req", id, method, args });
    });
  }

  private notify(method: "setName" | "setThinkingLevel" | "dispose", args: unknown[]): void {
    if (this.disposed && method !== "dispose") return;
    this.transport.send({ t: "notify", method, args });
  }

  // ---- RuntimeSession: streaming state --------------------------------------

  get sessionFile(): string | undefined {
    return this._sessionFile;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  activePid(): number | undefined {
    return this._activePid;
  }

  getMessages(): RuntimeMessage[] {
    return this._messages;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  // ---- RuntimeSession: turn control -----------------------------------------

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    await this.request<void>("prompt", [text, options ?? {}]);
  }

  async abort(): Promise<void> {
    // Settle any question card blocking on the interceptor before the round-trip.
    for (const controller of this.interceptAborts.values()) controller.abort();
    await this.request<void>("abort", []);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Send the `dispose` notify BEFORE closing so the agent service reaps the
    // child (rather than detaching it). If the link is already gone the session
    // was detached earlier, so there is nothing local left to reap.
    try {
      this.notify("dispose", []);
    } catch {
      // best-effort
    }
    this.teardownLocal("session disposed");
  }

  /**
   * Drop this local handle WITHOUT reaping the remote session (Stage 2). No
   * `dispose` notify is sent, so the agent service sees only the transport close
   * and DETACHES — keeping the child alive so another handle (this daemon later,
   * or another daemon) can re-attach via RemoteRuntime.attachSession. Used when
   * the daemon evicts a session from its local cache without ending it.
   */
  detach(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownLocal("session detached");
  }

  private teardownLocal(reason: string): void {
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    for (const controller of this.interceptAborts.values()) controller.abort();
    this.interceptAborts.clear();
    this.emitter.removeAllListeners();
    try {
      this.transport.close();
    } catch {
      // best-effort
    }
    this.onDispose?.();
  }

  // ---- RuntimeSession: models -----------------------------------------------

  async getModels(): Promise<ModelInfo[]> {
    return (await this.request<ModelInfo[]>("getModels", [])) ?? [];
  }

  getCurrentModel(): ModelInfo | undefined {
    return this._currentModel;
  }

  async setModel(provider: string, id: string): Promise<void> {
    // The `res` snapshot carries the new currentModel, applied by handleMessage.
    await this.request<void>("setModel", [provider, id]);
  }

  async getAllModels(): Promise<ModelInfo[]> {
    return (await this.request<ModelInfo[]>("getAllModels", [])) ?? [];
  }

  /** Warm the in-service session's catalog (spawn its agent without a prompt so
   *  a draft picker gets the real list) — the RPC sibling of the in-process
   *  runtimes' warmModels(). A no-op in-service for a static-catalog runtime. */
  async warmModels(): Promise<void> {
    await this.request<void>("warmModels", []);
  }

  // ---- RuntimeSession: thinking ---------------------------------------------

  getThinkingLevel(): string | undefined {
    return this._thinkingLevel;
  }

  setThinkingLevel(level: string): void {
    // Optimistically mirror so the daemon reads it back immediately, then notify.
    this._thinkingLevel = this._availableThinkingLevels.includes(level.trim()) ? level.trim() : undefined;
    this.notify("setThinkingLevel", [level]);
  }

  getAvailableThinkingLevels(): string[] {
    return this._availableThinkingLevels;
  }

  supportsThinking(): boolean {
    return this._supportsThinking;
  }

  // ---- RuntimeSession: naming -----------------------------------------------

  getName(): string | undefined {
    return this._name;
  }

  setName(name: string): void {
    this._name = name;
    this.notify("setName", [name]);
  }

  async suggestName(firstPrompt: string): Promise<string | undefined> {
    return this.request<string | undefined>("suggestName", [firstPrompt]);
  }

  // ---- RuntimeSession: misc capabilities ------------------------------------

  async interactiveTuiCommand(): Promise<TuiLaunchSpec | null> {
    return (await this.request<TuiLaunchSpec | null>("interactiveTuiCommand", [])) ?? null;
  }

  async getUsage(): Promise<UsageSnapshot | undefined> {
    return this.request<UsageSnapshot | undefined>("getUsage", []);
  }

  getCommands(): AgentCommand[] {
    return this._commands;
  }

  async invokeCommand(name: string, args: string): Promise<void> {
    await this.request<void>("invokeCommand", [name, args]);
  }
}

// ---------------------------------------------------------------------------
// Handshake / connector
// ---------------------------------------------------------------------------

export interface StartRemoteParams {
  runtime: string;
  sandbox?: string;
  op: StartOp;
  options: StartOptions;
}

/**
 * Drive the `start` handshake on a fresh transport and return a live session.
 * Buffers any events the service emits between `started` and the session being
 * wired, then replays them, so the first streamed frames are never dropped.
 */
export async function startRemoteSession(
  transport: RpcTransport,
  params: StartRemoteParams,
  options: RemoteSessionOptions = {},
): Promise<OpenSessionResult> {
  const startId = 1;
  const buffered: ServerMessage[] = [];
  // Held in an object so the closures below can read it before the (single) late
  // assignment once the handshake resolves.
  const state: { session?: RemoteRuntimeSession } = {};
  let settle: ((snapshot: InitialSnapshot) => void) | undefined;
  let fail: ((err: Error) => void) | undefined;
  const ready = new Promise<InitialSnapshot>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  transport.onMessage((message) => {
    if (state.session) {
      state.session.handleMessage(message);
      return;
    }
    if (message.t === "started" && message.id === startId) {
      settle?.(message.snapshot);
      return;
    }
    if (message.t === "res" && message.id === startId && message.ok === false) {
      fail?.(new Error(message.error));
      return;
    }
    buffered.push(message);
  });
  transport.onClose((err) => {
    if (state.session) state.session.handleClose(err);
    else fail?.(err ?? new Error("agent service connection closed during start"));
  });

  const startedAt = Date.now();
  // Deadline the handshake: if the service never answers `start` (down, wedged,
  // mid-restart) settle would hang forever, blocking the session open. On timeout
  // reject AND tear the transport down so we don't leak the half-open socket.
  const timer = setTimeout(() => {
    fail?.(new Error(`agent service handshake timed out after ${REMOTE_HANDSHAKE_TIMEOUT_MS}ms (op=${params.op})`));
    try {
      transport.close();
    } catch {
      // best-effort
    }
  }, REMOTE_HANDSHAKE_TIMEOUT_MS);
  timer.unref?.();

  transport.send({
    t: "start",
    id: startId,
    protocol: RPC_PROTOCOL_VERSION,
    runtime: params.runtime,
    sandbox: params.sandbox,
    op: params.op,
    options: params.options,
  });

  let snapshot: InitialSnapshot;
  try {
    snapshot = await ready;
  } finally {
    clearTimeout(timer);
    logRemoteTiming(`handshake op=${params.op}`, startedAt);
  }
  const session = new RemoteRuntimeSession(transport, snapshot, options);
  state.session = session;
  for (const message of buffered) session.handleMessage(message);
  return { session, warning: snapshot.warning };
}

// ---------------------------------------------------------------------------
// Concrete socket transport
// ---------------------------------------------------------------------------

export interface RemoteRuntimeAddress {
  /** "unix:/path/to.sock" | "host:port" | ":port" | "port". */
  raw: string;
}

/** Parse a remote-runtime address into `net.connect` options. */
export function parseRemoteAddress(raw: string): net.NetConnectOpts {
  const value = raw.trim();
  if (value.startsWith("unix:")) return { path: value.slice("unix:".length) };
  if (value.startsWith("/") || value.startsWith("./")) return { path: value };
  const lastColon = value.lastIndexOf(":");
  if (lastColon >= 0) {
    const host = value.slice(0, lastColon) || "127.0.0.1";
    const port = Number(value.slice(lastColon + 1));
    if (Number.isInteger(port) && port > 0) return { host, port };
  }
  const port = Number(value);
  if (Number.isInteger(port) && port > 0) return { host: "127.0.0.1", port };
  throw new Error(`Invalid remote runtime address: ${raw}`);
}

/** Connect a real socket transport to the agent service. */
export function connectSocketTransport(raw: string): Promise<RpcTransport> {
  const opts = parseRemoteAddress(raw);
  return new Promise((resolve, reject) => {
    const socket = net.connect(opts);
    const decoder = new FrameDecoder();
    let messageHandler: ((m: ServerMessage) => void) | undefined;
    let closeHandler: ((err?: Error) => void) | undefined;
    let settled = false;
    let closeErr: Error | undefined;

    // Bound the TCP/unix connect itself. Without this a black-holed host (dropped
    // SYNs, no RST) leaves us waiting for the OS connect timeout — the tens of
    // seconds a user sees when the agent service is unreachable.
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`agent service connect timed out after ${REMOTE_CONNECT_TIMEOUT_MS}ms (${raw})`));
    }, REMOTE_CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    socket.once("connect", () => {
      clearTimeout(connectTimer);
      settled = true;
      resolve({
        send(message) {
          socket.write(encodeFrame(message));
        },
        onMessage(handler) {
          messageHandler = handler;
        },
        onClose(handler) {
          closeHandler = handler;
          if (closeErr) handler(closeErr);
        },
        close() {
          // Graceful FIN so any just-written frame (notably the `dispose` notify,
          // which the service must see to REAP rather than detach) flushes first.
          // Fall back to a hard destroy if the peer doesn't close promptly.
          try {
            socket.end();
            setTimeout(() => socket.destroy(), 1000).unref();
          } catch {
            socket.destroy();
          }
        },
      });
    });
    socket.on("data", (chunk: Buffer) => {
      let messages: ServerMessage[];
      try {
        messages = decoder.push(chunk) as ServerMessage[];
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (messageHandler) for (const message of messages) messageHandler(message);
    });
    socket.on("error", (error) => {
      if (!settled) {
        clearTimeout(connectTimer);
        settled = true;
        reject(error);
        return;
      }
      closeErr = error;
    });
    socket.on("close", () => {
      if (closeHandler) closeHandler(closeErr);
    });
  });
}

// ---------------------------------------------------------------------------
// RemoteRuntime (AgentRuntime facade)
// ---------------------------------------------------------------------------

export interface RemoteRuntimeConfig {
  /** The runtime id the service should host (e.g. "claude-code-sdk"). */
  targetRuntime: string;
  displayName: string;
  capabilities: RuntimeCapabilities;
  /** Per-session sandbox tier, forwarded to the service's makeRuntime. */
  sandbox?: string;
  /**
   * The agent-service address this runtime connects to (as passed to
   * connectSocketTransport). Surfaced so the daemon can advertise a session's
   * host for Stage 2 re-attach routing. Optional; absent for injected transports.
   */
  agentServiceAddress?: string;
  /** Opens a transport to the agent service. Injected for tests. */
  connect: () => Promise<RpcTransport>;
}

/**
 * `AgentRuntime` facade the daemon holds in place of an in-process runtime. Each
 * createSession/openSession opens its OWN transport to the agent service (one
 * connection per session), which makes the service's lifecycle bookkeeping and
 * child ownership per-session and unambiguous.
 */
export class RemoteRuntime implements AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;
  /** The agent-service address this runtime drives (for Stage 2 advertise/route). */
  readonly agentServiceAddress?: string;

  constructor(private readonly config: RemoteRuntimeConfig) {
    this.id = config.targetRuntime;
    this.displayName = config.displayName;
    this.capabilities = config.capabilities;
    this.agentServiceAddress = config.agentServiceAddress;
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const transport = await this.config.connect();
    const toolSpecs = options.toolProvider?.list();
    return startRemoteSession(
      transport,
      { runtime: this.id, sandbox: this.config.sandbox, op: "create", options: { workspace: options.workspace, hasToolInterceptor: Boolean(options.toolInterceptor), ...(toolSpecs?.length ? { toolSpecs } : {}) } },
      { toolInterceptor: options.toolInterceptor, toolProvider: options.toolProvider },
    );
  }

  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    const transport = await this.config.connect();
    const toolSpecs = options.toolProvider?.list();
    return startRemoteSession(
      transport,
      { runtime: this.id, sandbox: this.config.sandbox, op: "open", options: { workspace: options.workspace, sessionFile: options.sessionFile, hasToolInterceptor: Boolean(options.toolInterceptor), ...(toolSpecs?.length ? { toolSpecs } : {}) } },
      { toolInterceptor: options.toolInterceptor, toolProvider: options.toolProvider },
    );
  }

  /**
   * Re-attach to a session already live on the agent service (Stage 2 routing).
   * The agent service keeps a session running after a daemon disconnect (the
   * "detach & keep running" policy), so ANY daemon that knows the session's
   * agent-service address can rebind to the same live child via the Stage 1
   * `attach` op — no in-process handle required. The daemon re-supplies its tool
   * interceptor so the guardian keeps adjudicating every tool after the hand-off.
   */
  async attachSession(sessionId: string, options: { toolInterceptor?: ToolInterceptor; toolProvider?: ToolProvider } = {}): Promise<OpenSessionResult> {
    const transport = await this.config.connect();
    const toolSpecs = options.toolProvider?.list();
    return startRemoteSession(
      transport,
      { runtime: this.id, sandbox: this.config.sandbox, op: "attach", options: { sessionId, hasToolInterceptor: Boolean(options.toolInterceptor), ...(toolSpecs?.length ? { toolSpecs } : {}) } },
      { toolInterceptor: options.toolInterceptor, toolProvider: options.toolProvider },
    );
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.runtimeCall<SessionSummary[]>("listSessions", [])) ?? [];
  }

  async deleteSession(sessionId: string, sessionFile?: string): Promise<boolean> {
    return (await this.runtimeCall<boolean>("deleteSession", [sessionId, sessionFile])) ?? false;
  }

  /** Session-less runtime-level RPC on a short-lived connection. */
  private async runtimeCall<T>(method: RuntimeRpcMethod, args: unknown[]): Promise<T | undefined> {
    const transport = await this.config.connect();
    const startedAt = Date.now();
    return new Promise<T | undefined>((resolve, reject) => {
      const id = 1;
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        logRemoteTiming(`rt ${method}`, startedAt);
        try {
          transport.close();
        } catch {
          // ignore
        }
        fn();
      };
      // A never-answered `res` (service wedged after connect) would hang this RPC
      // forever, and listSessions/listAllSessions fans this out across every
      // runtime — one stuck service stalls the whole session list. Deadline it.
      timer = setTimeout(() => {
        finish(() => reject(new Error(`agent service ${method} RPC timed out after ${REMOTE_RPC_TIMEOUT_MS}ms`)));
      }, REMOTE_RPC_TIMEOUT_MS);
      timer.unref?.();
      transport.onMessage((message) => {
        if (message.t === "res" && message.id === id) {
          if (message.ok) finish(() => resolve(message.value as T));
          else finish(() => reject(new Error(message.error)));
        }
      });
      transport.onClose((err) => finish(() => (err ? reject(err) : resolve(undefined))));
      transport.send({ t: "rt", id, protocol: RPC_PROTOCOL_VERSION, runtime: this.id, sandbox: this.config.sandbox, method, args });
    });
  }
}
