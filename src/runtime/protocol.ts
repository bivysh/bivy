// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { buildAgentCredentialEnv } from "./credentials.js";
import { bivySessionEnv } from "./session-env.js";
import { mergeAgentCommands, type SlashCommandProvider } from "./slash-commands.js";
import type {
  AgentCommand,
  AgentRuntime,
  AgentCredentialStore,
  CatalogProvider,
  DiscoveredNativeSession,
  ForkHistoryMessage,
  ForkImportContext,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  PromptOptions,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  StreamingBehavior,
  ToolInterceptor,
  TuiLaunchSpec,
  UsageSnapshot,
} from "./types.js";
import { withExactCapabilitySurface } from "./types.js";
import { extractTokenUsage } from "./cli-parsers.js";
import { mapToolCall, mapToolResult } from "./tool-call-map.js";

/** A protocol `usage` message → UsageSnapshot (reuses the CLI token-key scan). */
function parseProtocolUsage(raw: unknown): UsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const tokenUsage = extractTokenUsage(o.tokens ?? o);
  const snapshot: UsageSnapshot = tokenUsage ? { ...tokenUsage } : {};
  if (typeof o.costUsd === "number") snapshot.costUsd = o.costUsd;
  return Object.keys(snapshot).length ? snapshot : undefined;
}

export interface ProtocolRuntimeOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  displayName?: string;
  /**
   * Runtime id. Defaults to "bivy-agent-protocol"; a concrete adapter (e.g. the
   * Codex app-server shim) sets its own agent id so takeover/discovery and the UI
   * keep treating it as that agent.
   */
  id?: string;
  /**
   * Seed capabilities known before the handshake. The agent's hello can still
   * refine them, but seeding `toolInterception: true` up front matters: the daemon
   * decides whether to pass `guardianInterceptor` from `runtime.capabilities` when
   * the *first* session is created — before hello arrives — so an unseeded runtime
   * would skip approvals on its first session.
   */
  capabilities?: Partial<RuntimeCapabilities>;
  /**
   * Shared credential vault. When set, the node's model-provider logins are
   * injected into the protocol agent subprocess as conventional provider env
   * vars, so one Bivy sign-in serves this agent too.
   */
  credentials?: AgentCredentialStore;
  /**
   * Credential preflight (mirrors ProcessRuntime). Returns a human-readable error
   * when the agent has no usable credential, so Bivy surfaces a clear, actionable
   * message instead of spawning a shim whose first turn dies with an opaque
   * upstream 401. Returning undefined = proceed. Run per prompt, before the first
   * turn opens.
   */
  preflight?: (
    env: Record<string, string | undefined>,
    ctx: { provider?: string },
  ) => string | undefined;
  /**
   * Optional preparation run before the child spawns (mirrors ProcessRuntime) —
   * e.g. Codex mints its `auth.json` from Bivy's vault and pins `CODEX_HOME`, so a
   * subscription connected in the app satisfies the preflight and the run. Returns
   * an env patch merged into the spawn env. Best-effort: a throw/rejection is
   * swallowed and treated as no patch.
   */
  prepare?: (env: Record<string, string | undefined>) => Promise<Record<string, string> | void> | Record<string, string> | void;
  /** Session-less provider/model catalog this agent contributes to the unified picker. */
  catalog?: CatalogProvider[];
  /**
   * Resume support (mirrors ProcessRuntime). When set, `openSession({ sessionFile })`
   * reconnects the agent's own session: the persisted `runtimeSessionRef` is passed
   * back through the generic `session.resume` command, and `capabilities.resume` is
   * forced true even if the handshake omitted it. A shim opts in by handling
   * `session.resume` and advertising `resume: true` in its hello.
   */
  resumable?: boolean;
  /**
   * Optional: preload prior turns from disk for a resumed session, keyed by the
   * persisted `runtimeSessionRef`, so a re-opened chat isn't blank before the
   * agent streams anything. (For Codex this is `loadCodexTranscript`.)
   */
  loadHistory?: (runtimeSessionRef: string) => RuntimeMessage[];
  /**
   * Optional: remove a session's transcript from the agent's own on-disk store on
   * a user-initiated delete (for Codex this is `deleteCodexSession`), so deleting
   * it in the app actually sticks and doesn't leak the rollout. The write-side
   * counterpart to `loadHistory`. Best-effort; must not throw for a missing file.
   */
  deleteHistory?: (runtimeSessionRef: string) => void;
  /**
   * Optional: materialise a **cross-runtime** fork's portable `{role, text}`
   * history into this agent's own resumable store, returning the new resume ref
   * + id, so a fork *into* this agent is a true replay rather than a seeded
   * summary (backs `capabilities.forkHistoryImport` + `importHistoryForFork`; for
   * Codex this is `writeCodexRollout`). The write-side counterpart to
   * `loadHistory`. Best-effort — the fork engine falls back to a seeded prompt if
   * this throws. Absent = no history import for this agent.
   */
  writeHistory?: (history: ForkHistoryMessage[], ctx: ForkImportContext) => { sessionFile: string; id: string };
  /** Runtime-specific, side-effect-free title request (for example `codex exec --ephemeral`). */
  suggestName?: (firstPrompt: string, context: { cwd: string; model?: string }) => Promise<string | undefined>;
  /**
   * Enumerate this agent's own provider-native sessions on this node that Bivy
   * did not start (issue #156's discovery/adoption flow — for Codex this is
   * `discoverNativeCodexSessions`). Pair with `capabilities.nativeSessionDiscovery`
   * (seeded via `capabilities` above); absent = no discovery for this agent.
   */
  discoverNativeSessions?: () => Promise<DiscoveredNativeSession[]> | DiscoveredNativeSession[];
  /**
   * Describe how to resume this session in the agent's own interactive TUI on
   * this node (see RuntimeSession.interactiveTuiCommand — the "Continue in
   * terminal" hand-off). Given the agent's own session ref and the resolved launch
   * env (the same `prepare` + credential env a turn spawns with, so the TUI
   * authenticates identically), returns a TuiLaunchSpec or null when there's
   * nothing to resume yet. Pair with `capabilities.interactiveTui`. For Codex this
   * is `codex resume <rolloutId>`. Absent = no TUI hand-off for this agent.
   */
  interactiveTui?: (info: { sessionRef?: string; cwd: string; env: Record<string, string> }) => TuiLaunchSpec | null;
  /**
   * Optional on-disk slash commands (see SlashCommandProvider), merged with any
   * the shim advertises in its hello. When set, the session's getCommands()
   * advertises them and prompt() expands a matching `/name args` line into the
   * command's body before `chat.send` — Codex/opencode custom prompts don't expand
   * on the app-server/ACP path Bivy drives, so Bivy expands them itself. Absent =
   * only the shim's hello-advertised commands (if any).
   */
  slashCommands?: SlashCommandProvider;
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

export function protocolRuntimeFromEnv(): ProtocolRuntimeOptions | null {
  const command = process.env.BIVY_PROTOCOL_COMMAND?.trim();
  if (!command) return null;
  const commands = protocolCommandsFromEnv();
  return {
    command,
    args: splitArgs(process.env.BIVY_PROTOCOL_ARGS),
    displayName: process.env.BIVY_PROTOCOL_NAME?.trim() || "Bivy Protocol Agent",
    // Seed advertised slash commands so the composer can offer them before the
    // first session's hello lands (the constructor merges these into the live
    // capabilities, and a hello that omits `commands` preserves the seed).
    ...(commands ? { capabilities: { commands } } : {}),
  };
}

/**
 * Agent-native slash commands a protocol shim declares up front via
 * `BIVY_PROTOCOL_COMMANDS` — a JSON array of `{ name, description }`, e.g.
 * `[{"name":"/compact","description":"Compact the conversation."}]`. Seeding
 * them (rather than only advertising via the hello) lets the composer offer them
 * in autocomplete before any session exists, and keeps the catalog RuntimeInfo
 * and the live runtime in agreement. Malformed entries are dropped; returns
 * undefined when nothing valid is set.
 */
export function protocolCommandsFromEnv(): AgentCommand[] | undefined {
  const raw = process.env.BIVY_PROTOCOL_COMMANDS?.trim();
  if (!raw) return undefined;
  try {
    return parseAgentCommands(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Validate a `streamingBehaviors` array from a hello (e.g.
 * `["steer","followUp"]`). A shim must explicitly opt in before the client
 * will ever attempt a mid-turn prompt against it — see RuntimeCapabilities.
 * streamingBehaviors — so anything malformed/absent is dropped rather than
 * defaulted to some assumed support.
 */
function parseStreamingBehaviors(raw: unknown): StreamingBehavior[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = Array.from(new Set(raw.filter((v): v is StreamingBehavior => v === "steer" || v === "followUp")));
  return out.length ? out : undefined;
}

function capabilitiesFromHello(raw: unknown): RuntimeCapabilities {
  const c = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const streamingBehaviors = parseStreamingBehaviors(c.streamingBehaviors);
  return withExactCapabilitySurface({
    toolInterception: c.toolInterception === true,
    modelSelection: c.modelSelection === true,
    packages: false,
    resume: c.resume === true,
    fork: false,
    commands: parseAgentCommands(c.commands),
    ...(streamingBehaviors ? { streamingBehaviors } : {}),
  });
}

/**
 * Validate the `commands` array from a hello. Each entry must carry a "/name"
 * string; anything malformed is dropped so a sloppy shim can't inject junk into
 * the composer menu. Returns undefined when nothing valid is advertised, keeping
 * the capability absent rather than an empty array.
 */
/**
 * Validate a `models` array advertised in a shim's hello (`hello.runtime.models`).
 * Each entry needs a string `id` (the agent's own model name); `name`/`provider`
 * are optional. Anything malformed is dropped so a sloppy shim can't inject junk
 * into the picker. Returns [] when nothing valid is advertised.
 */
export function parseModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  for (const entry of raw) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id) continue;
    out.push({
      provider: typeof e.provider === "string" && e.provider.trim() ? e.provider : "agent",
      id,
      name: typeof e.name === "string" && e.name.trim() ? e.name : id,
      reasoning: e.reasoning === true || undefined,
    });
  }
  return out;
}

export function parseAgentCommands(raw: unknown): AgentCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentCommand[] = [];
  for (const entry of raw) {
    const e = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name.startsWith("/") || name.length < 2) continue;
    const description = typeof e.description === "string" ? e.description.trim() : undefined;
    // Only honor the two known invocation modes; anything else (including a
    // sloppy shim advertising junk) falls back to prompt invocation, which every
    // agent can serve. "protocol" is honored because ProtocolSession backs it
    // with a real `command.invoke` message.
    const mode = e.mode === "protocol" ? "protocol" : e.mode === "prompt" ? "prompt" : undefined;
    const command: AgentCommand = { name };
    if (description) command.description = description;
    if (mode) command.mode = mode;
    out.push(command);
  }
  return out.length ? out : undefined;
}

class ProtocolSession implements RuntimeSession {
  readonly id: string;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private emitter = new EventEmitter();
  private messages: RuntimeMessage[] = [];
  private streaming = false;
  private name?: string;
  private runtimeSessionRef?: string;
  private readonly resumeRef?: string;
  private started = false;
  private assistantText = "";
  private reasoningText = "";
  private stderrOutput = "";
  private lastUsage?: UsageSnapshot;
  // Accumulate the current turn's content blocks (text + tool calls, in the order
  // they actually happened) and tool results so getMessages() keeps them in
  // history — re-opening a session then shows what the agent actually did,
  // interleaved exactly as it happened, not just its final text. Cleared at the
  // start/end of each turn. `turnTextFlushed` is the prefix of `assistantText`
  // already sealed into `turnContent` as a text block — each tool call flushes
  // the text since the last flush before appending its own block, so a turn like
  // "Let me check." → tool → "Now editing." → tool persists as
  // [text, tool_use, text, tool_use] instead of collapsing into one text block
  // followed by every tool (which is what re-flattened on reconcile and read as
  // interim messages "disappearing"/bundling at the end of the turn).
  private turnContent: Array<Record<string, unknown>> = [];
  private turnTextFlushed = "";
  private turnToolResults: Array<Record<string, unknown>> = [];
  // toolCallId -> the node's normalized classification, so a later tool.result
  // (or tool.update) can attach/refresh `detail` on the already-pushed block.
  private toolDetailsByCallId = new Map<string, ReturnType<typeof mapToolCall>>();

  constructor(
    private readonly runtimeOptions: ProtocolRuntimeOptions,
    public readonly cwd: string,
    private readonly capabilitiesRef: RuntimeCapabilities,
    private readonly toolInterceptor?: ToolInterceptor,
    // When resuming, the agent's own session ref (e.g. a Codex thread id). Passed
    // back to the shim via the generic session.resume primitive so it reconnects
    // instead of starting fresh; also used to preload history.
    resumeRef?: string,
  ) {
    this.id = resumeRef || randomUUID();
    this.resumeRef = resumeRef;
    if (resumeRef) {
      this.runtimeSessionRef = resumeRef;
      if (runtimeOptions.loadHistory) {
        try {
          this.messages = runtimeOptions.loadHistory(resumeRef);
        } catch {
          // Best-effort preload; a resumed session can start blank if the
          // transcript can't be read, and the agent still continues from its ref.
        }
      }
    }
  }

  // The resume token the daemon persists and passes to openSession() later: the
  // agent's own session ref. undefined until session.create replies for a fresh
  // session.
  get sessionFile(): string | undefined { return this.runtimeSessionRef ?? this.resumeRef; }

  get isStreaming(): boolean { return this.streaming; }
  /** PID of the live agent subprocess (see RuntimeSession). */
  activePid(): number | undefined { return this.child?.pid; }
  getMessages(): RuntimeMessage[] { return this.messages; }
  // Models advertised by the shim's hello (hello.runtime.models); empty when the
  // agent doesn't expose a picker. setModel forwards the choice as a `model.set`
  // command the shim answers, so selection is real transport, not a stub.
  private models: ModelInfo[] = [];
  private currentModelId?: string;
  /** Provider of the selected model — scopes custom base-URL env injection. */
  private currentModelProvider?: string;
  /** Env patch from the last `prepare` run (e.g. Codex's minted CODEX_HOME),
   *  applied to the spawned child and reused by the per-turn preflight. */
  private prepareEnv: Record<string, string> = {};
  getModels(): ModelInfo[] { return this.models; }
  getCurrentModel(): ModelInfo | undefined {
    if (!this.currentModelId) return undefined;
    return this.models.find((m) => m.id === this.currentModelId) ?? { provider: "agent", id: this.currentModelId, name: this.currentModelId };
  }
  async setModel(provider: string, id: string): Promise<void> {
    if (!this.models.length) throw new Error("Model selection is not supported by this protocol agent.");
    const modelId = id.trim();
    if (!modelId) { this.currentModelId = undefined; this.currentModelProvider = undefined; return; }
    // Forward to the shim and only commit the selection once it acknowledges.
    await this.command("model.set", { sessionId: this.id, model: modelId });
    this.currentModelId = modelId;
    this.currentModelProvider = provider?.trim().toLowerCase() || undefined;
  }
  async getUsage(): Promise<UsageSnapshot | undefined> { return this.lastUsage; }

  /**
   * Invoke a protocol-mode agent command out-of-band (see AgentCommand.mode).
   * Ensures the child + session are up, then sends a `command.invoke` the shim
   * answers. Any streamed output/events the command produces arrive over the
   * normal event channel (session.status / message.delta / session.done), so a
   * command that "runs a turn" (e.g. `/compact`) surfaces exactly like a prompt.
   */
  async invokeCommand(name: string, args: string): Promise<void> {
    await this.open();
    await this.command("command.invoke", { sessionId: this.id, runtimeSessionRef: this.runtimeSessionRef, name, args: args ?? "" });
  }
  /** The session's slash commands: on-disk custom prompts (Codex/opencode) merged
   *  with whatever the shim advertised in its hello, disk winning a collision.
   *  Best-effort and display-only — a read failure just drops the on-disk set. */
  getCommands(): AgentCommand[] {
    let disk: AgentCommand[] | undefined;
    try {
      disk = this.runtimeOptions.slashCommands?.list(this.cwd);
    } catch {
      disk = undefined;
    }
    return mergeAgentCommands(disk, this.capabilitiesRef.commands);
  }
  /**
   * Resume this session in the agent's own interactive TUI (see the runtimeOptions
   * hook). Resolves the same launch env a turn would — `prepare` (e.g. Codex
   * mints CODEX_HOME + auth.json) then credentials — so the TUI opens with the
   * identical auth as chat. Returns null when the runtime has no TUI hook or there
   * is no session ref to resume yet (the daemon then surfaces "no TUI available").
   */
  async interactiveTuiCommand(): Promise<TuiLaunchSpec | null> {
    const hook = this.runtimeOptions.interactiveTui;
    if (!hook) return null;
    const credentialEnv = this.runtimeOptions.credentials
      ? await buildAgentCredentialEnv(this.runtimeOptions.credentials, undefined, this.currentModelProvider).catch(() => ({}))
      : {};
    let prepareEnv = this.prepareEnv;
    if (this.runtimeOptions.prepare) {
      prepareEnv =
        (await Promise.resolve(this.runtimeOptions.prepare({ ...process.env, ...this.runtimeOptions.env, ...credentialEnv })).catch(() => undefined)) ??
        prepareEnv;
    }
    const env = { ...this.runtimeOptions.env, ...credentialEnv, ...prepareEnv };
    return hook({ sessionRef: this.runtimeSessionRef ?? this.resumeRef, cwd: this.cwd, env });
  }
  getName(): string | undefined { return this.name; }
  setName(name: string): void { this.name = name; }
  async suggestName(firstPrompt: string): Promise<string | undefined> {
    return this.runtimeOptions.suggestName?.(firstPrompt, { cwd: this.cwd, model: this.currentModelId });
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  private emit(event: RuntimeEvent) { this.emitter.emit("event", event); }

  async start(): Promise<void> {
    if (this.child) return;
    const credentialEnv = this.runtimeOptions.credentials
      ? await buildAgentCredentialEnv(this.runtimeOptions.credentials, undefined, this.currentModelProvider).catch(() => ({}))
      : {};
    // Optional prepare step, run before the child spawns because a shim reads its
    // credential at launch (e.g. Codex mints ~/.codex/auth.json from the vault and
    // pins CODEX_HOME). Stored so the per-turn preflight sees the same env. Best-
    // effort: a throw is swallowed and treated as no patch.
    this.prepareEnv = this.runtimeOptions.prepare
      ? (await Promise.resolve(this.runtimeOptions.prepare({ ...process.env, ...this.runtimeOptions.env, ...credentialEnv })).catch(() => undefined)) ?? {}
      : {};
    const child = spawn(this.runtimeOptions.command, this.runtimeOptions.args ?? [], {
      cwd: this.cwd,
      // bivySessionEnv() lets the agent's own shell resolve its session for
      // `bivy attach <path>` (see session-env.ts); spread last so it can never
      // be shadowed by an operator-configured env var of the same name.
      env: { ...process.env, ...this.runtimeOptions.env, ...credentialEnv, ...this.prepareEnv, ...bivySessionEnv(this.id) },
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrOutput += chunk.toString("utf8");
      this.emit({ type: "tool_execution_update", toolName: "agent_output", toolCallId: "agent-output", input: { stream: "stderr", output: this.stderrOutput.slice(-4000) } });
    });
    // The agent's stdin pipe can break (EPIPE) when the shim exits mid-turn — for
    // example a dispose()/abort() racing an in-flight write (a tool.decision reply,
    // a chat.send). Node emits that as an 'error' on the stdin socket; with no
    // listener it is fatal to the whole daemon. Absorb it: the child is already
    // gone, so mark the turn stopped and fail any pending commands instead of
    // crashing the process over a normal teardown race.
    child.stdin.on("error", (error) => { this.streaming = false; this.failAll(error instanceof Error ? error : new Error(String(error))); });
    child.on("error", (error) => {
      // Spawn/pipe failure — the child never became usable. Forget it so the next
      // open()/prompt() respawns instead of writing to a dead pipe forever.
      if (this.child === child) this.markChildGone();
      this.failAll(error);
    });
    child.on("close", (code, signal) => {
      this.streaming = false;
      // The long-lived shim exited — a crash, the user's Stop (SIGKILL), or the
      // turn-watchdog's abort of a wedged agent. Forget the child AND the fact
      // that a session was opened on it, so the NEXT open()/prompt() respawns the
      // shim and re-resumes the agent's own session (by runtimeSessionRef) instead
      // of every later command throwing "Protocol agent is not running." at the
      // corpse — which pinned opencode/Codex/Gemini sessions permanently
      // unresumable after a single stall recovery. Guard on `=== child` so a late
      // event from a prior child can't null a freshly respawned one.
      if (this.child === child) this.markChildGone();
      this.failAll(new Error(`Protocol agent exited (${code ?? signal ?? "unknown"})`));
      this.emit({ type: "agent_end", code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Protocol agent did not send hello.")), 10_000);
      const onHello = (msg: Record<string, unknown>) => {
        if (msg.type !== "hello") return;
        clearTimeout(timer);
        this.emitter.off("protocol-message", onHello);
        const runtime = msg.runtime as Record<string, unknown> | undefined;
        const next = capabilitiesFromHello(runtime?.capabilities ?? msg.capabilities);
        // A hello that advertises no commands must not wipe commands seeded via
        // ProtocolRuntimeOptions.capabilities (a shim may declare them up front).
        if (next.commands === undefined) delete next.commands;
        Object.assign(this.capabilitiesRef, next);
        // Model registry: a shim that advertises models gets a real picker —
        // getModels() returns these and setModel() forwards a model.set command.
        const models = parseModels(runtime?.models ?? msg.models);
        if (models.length) {
          this.models = models;
          this.capabilitiesRef.modelSelection = true;
          const current = typeof runtime?.currentModel === "string" ? runtime.currentModel : typeof msg.currentModel === "string" ? msg.currentModel : undefined;
          if (current) this.currentModelId = current;
        }
        // A runtime configured `resumable` keeps resume support even if a shim's
        // hello omits the flag — the resume plumbing (session.create `resume` +
        // openSession) lives on the Bivy side, so the option is authoritative.
        if (this.runtimeOptions.resumable) this.capabilitiesRef.resume = true;
        this.write({ id: "cmd_hello_ack", type: "hello.ack", maxProtocol: "bivy-agent-protocol/0" });
        resolve();
      };
      this.emitter.on("protocol-message", onHello);
      child.once("error", reject);
    });
  }

  private onData(data: string) {
    this.buffer += data;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { this.emit({ type: "runtime.debug", message: `Invalid protocol JSON: ${line.slice(0, 200)}` }); continue; }
      this.handleMessage(msg);
    }
  }

  /** Seal the assistant text streamed since the last flush as a text block in
   *  `turnContent`, ahead of a tool call (or at turn end) — see turnContent's
   *  doc comment for why this preserves interleaving on reconcile. */
  private flushPendingTurnText(): void {
    const pending = this.assistantText.slice(this.turnTextFlushed.length);
    this.turnTextFlushed = this.assistantText;
    if (pending) this.turnContent.push({ type: "text", text: pending });
  }

  /**
   * Fold assistant text that arrives after the turn was sealed (session.done)
   * onto the last persisted assistant message — the ACP end_turn race (see the
   * message.delta branch). The daemon's message_end handler re-snapshots the
   * base transcript, so the tail survives a reopen; live viewers catch up via
   * the emitted message_update + message_end. Text with no assistant message to
   * fold onto is dropped (there is nowhere durable for it to go).
   */
  private foldLateAssistantDelta(text: string): void {
    let lastIndex = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === "assistant") { lastIndex = i; break; }
    }
    if (lastIndex < 0) return;
    const msg = this.messages[lastIndex]!;
    const raw = msg.content;
    const content: Array<{ type: string; text?: string }> = Array.isArray(raw)
      ? (raw as Array<{ type: string; text?: string }>)
      : typeof raw === "string" && raw
        ? [{ type: "text", text: raw }]
        : [];
    const lastBlock = content[content.length - 1];
    if (lastBlock && lastBlock.type === "text") lastBlock.text = `${lastBlock.text ?? ""}${text}`;
    else content.push({ type: "text", text });
    msg.content = content;
    this.emit({ type: "message_update", message: { role: "assistant", content } });
    this.emit({ type: "message_end", message: { role: "assistant", content } });
  }

  private handleMessage(msg: Record<string, unknown>) {
    this.emitter.emit("protocol-message", msg);
    const replyTo = typeof msg.replyTo === "string" ? msg.replyTo : "";
    if (replyTo && this.pending.has(replyTo)) {
      const pending = this.pending.get(replyTo)!;
      clearTimeout(pending.timer);
      this.pending.delete(replyTo);
      if (msg.ok === false) pending.reject(new Error(String(msg.error || "Protocol command failed")));
      else pending.resolve(msg);
      return;
    }
    void this.handleEvent(msg);
  }

  private async handleEvent(msg: Record<string, unknown>) {
    const type = String(msg.type || "runtime.event");
    if (type === "session.started") {
      if (typeof msg.runtimeSessionRef === "string") this.runtimeSessionRef = msg.runtimeSessionRef;
      return;
    }
    // Late-arriving model registry. A shim that knows its models up front puts them
    // in `hello`; one whose list is only knowable per session — an ACP agent's
    // models depend on which providers the user has authenticated, and arrive with
    // session/new — publishes them here instead. Same contract as the hello path: a
    // picker backed by a real `model.set` the shim answers, never a claimed one.
    if (type === "runtime.models") {
      const models = parseModels(msg.models);
      if (models.length) {
        this.models = models;
        this.capabilitiesRef.modelSelection = true;
        if (typeof msg.currentModel === "string") this.currentModelId = msg.currentModel;
      }
      return;
    }
    if (type === "message.delta") {
      const text = String(msg.text ?? "");
      if (!text) return;
      if (this.streaming) {
        if (!this.assistantText) this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
        this.assistantText += text;
        this.emit({ type: "message_update", message: { role: "assistant", content: this.assistantText } });
        return;
      }
      // The turn was already sealed (session.done) yet the agent is still
      // streaming text — the ACP end_turn race where the final agent_message_chunk
      // frames land after the prompt reply (opencode#17505). The shim drains the
      // tail before declaring done, but this is the net for a chunk that outlives
      // the drain: fold it onto the last assistant message so it survives a reopen
      // instead of opening a fresh draft that is never persisted.
      this.foldLateAssistantDelta(text);
      return;
    }
    if (type === "message.reasoning" || type === "reasoning.delta") {
      // Reasoning/thinking stream → the same intermediate thinking block the
      // daemon renders for Pi/Claude (display-only, kept out of the transcript).
      const text = String(msg.text ?? msg.delta ?? "");
      if (text) {
        this.reasoningText += text;
        this.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: this.reasoningText }] } });
      }
      return;
    }
    if (type === "usage") {
      // Best-effort token/cost snapshot the shim reports; surfaced via getUsage().
      this.lastUsage = parseProtocolUsage(msg.usage ?? msg);
      return;
    }
    if (type === "session.status") {
      const status = String(msg.status || "");
      if (status === "working") this.emit({ type: "turn_start" });
      if (status === "idle") this.emit({ type: "turn_end" });
      return;
    }
    if (type === "session.done") {
      // Whether this turn ever used a tool — checked BEFORE flushing trailing
      // text, so a tool-free turn (turnContent still empty at this point) keeps
      // the plain-text message shape it always had instead of gaining a
      // pointless single-text-block wrapper.
      const hadTools = this.turnContent.length > 0 || this.turnToolResults.length > 0;
      const message = { role: "assistant", content: this.assistantText };
      // Persist the assistant turn. When the turn used tools, store the ordered
      // content blocks (text/tool_use interleaved exactly as they streamed — see
      // turnContent's doc comment) plus a trailing user message carrying the
      // tool_result blocks, matched by tool_use_id — the same shape the PWA
      // renders from live streaming, so a re-opened transcript looks identical to
      // what was on screen. A tool-free turn keeps the plain-text form it always used.
      if (hadTools) {
        this.flushPendingTurnText();
        if (this.turnContent.length) this.messages.push({ role: "assistant", content: this.turnContent, timestamp: Date.now() });
        if (this.turnToolResults.length) this.messages.push({ role: "user", content: this.turnToolResults, timestamp: Date.now() });
      } else if (this.assistantText) {
        this.messages.push(message);
      }
      this.emit({ type: "message_end", message });
      this.streaming = false;
      this.assistantText = "";
      this.reasoningText = "";
      this.turnContent = [];
      this.turnTextFlushed = "";
      this.turnToolResults = [];
      this.toolDetailsByCallId.clear();
      this.emit({ type: "agent_end" });
      return;
    }
    if (type === "session.error") {
      this.streaming = false;
      this.reasoningText = "";
      this.turnContent = [];
      this.turnTextFlushed = "";
      this.turnToolResults = [];
      this.toolDetailsByCallId.clear();
      this.emit({ type: "session.error", error: String(msg.error || "Protocol agent error") });
      this.emit({ type: "agent_end" });
      return;
    }
    if (type === "tool.call") {
      const toolCallId = String(msg.toolCallId || msg.id || "");
      const toolName = String(msg.name || "tool");
      const detail = mapToolCall(toolName, msg.input, { provider: this.runtimeOptions.id || "acp", protocol: "protocol" });
      if (detail) this.toolDetailsByCallId.set(toolCallId, detail);
      this.flushPendingTurnText();
      this.turnContent.push({ type: "tool_use", id: toolCallId, name: toolName, input: msg.input ?? {}, ...(detail ? { detail } : {}) });
    }
    if (type === "tool.call" && this.capabilitiesRef.toolInterception && this.toolInterceptor) {
      const toolCallId = String(msg.toolCallId || "");
      const toolName = String(msg.name || "tool");
      const detail = this.toolDetailsByCallId.get(toolCallId);
      this.emit({ type: "tool_call", toolName, input: msg.input, toolCallId, ...(detail ? { detail } : {}) });
      const decision = await this.toolInterceptor({ sessionId: this.id, toolName, input: msg.input });
      try {
        this.write({ id: randomUUID(), type: "tool.decision", sessionId: this.id, toolCallId, decision: decision?.block ? "deny" : "allow", reason: decision?.reason });
      } catch {
        // The child exited before we could answer (aborted/disposed mid-turn).
        // There is nowhere to deliver the decision; drop it rather than throw out
        // of this async event handler (which would surface as an unhandled rejection).
      }
      return;
    }
    if (type === "tool.update") {
      // A tool call's structured data can arrive progressively (e.g. opencode's
      // ACP shim often has an empty `rawInput` on the initial notification and
      // fills in `content`/`locations` on a later update) — refresh the
      // already-pushed turnContent block in place (never append a duplicate) and
      // push a live update so an open tool card fills in without waiting for the
      // turn to end and history to reconcile.
      const toolCallId = String(msg.toolCallId || "");
      const toolName = String(msg.name || "tool");
      const detail = mapToolCall(toolName, msg.input, { provider: this.runtimeOptions.id || "acp", protocol: "protocol" });
      if (detail) this.toolDetailsByCallId.set(toolCallId, detail);
      const block = this.turnContent.find((b) => b.type === "tool_use" && b.id === toolCallId);
      if (block) {
        block.name = toolName;
        block.input = msg.input ?? {};
        if (detail) block.detail = detail;
      }
      this.emit({ type: "tool_execution_update", toolName, input: msg.input, toolCallId, ...(detail ? { detail } : {}) });
      return;
    }
    if (type === "tool.result") {
      const toolCallId = String(msg.toolCallId || msg.tool_use_id || msg.id || "");
      const result = msg.result ?? msg.output ?? msg.content ?? msg.text ?? msg.summary ?? "";
      const isError = Boolean(msg.isError || msg.is_error);
      this.turnToolResults.push({
        type: "tool_result",
        tool_use_id: toolCallId,
        content: result,
        ...(isError ? { is_error: true } : {}),
      });
      const priorDetail = this.toolDetailsByCallId.get(toolCallId);
      const detail = priorDetail ? { ...priorDetail, result: mapToolResult(result, isError) } : undefined;
      this.emit({ type: "tool_result", toolName: String(msg.name || "tool"), toolCallId, result, ...(detail ? { detail } : {}) });
      return;
    }
    this.emit({ type, ...msg });
  }

  private write(obj: Record<string, unknown>) {
    if (!this.child || this.child.killed) throw new Error("Protocol agent is not running.");
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private command(type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = randomUUID();
    const out = { id, type, ...payload };
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(out);
    return promise;
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /**
   * The child process is gone. Reset the spawn/session flags so the next
   * open()/prompt() transparently respawns the shim and re-resumes (open()
   * prefers session.resume when a runtimeSessionRef exists). The agent's own
   * session ref, its loaded history, and the selected model are all preserved —
   * only the dead OS process handle and the stale read buffer are dropped. This
   * is the shared crash/abort recovery for every protocol agent.
   */
  private markChildGone(): void {
    this.child = undefined;
    this.started = false;
    this.buffer = "";
  }

  async open(): Promise<void> {
    await this.start();
    if (this.started) return;
    // Resume by the agent's own session ref whenever we have one: either passed
    // at construction (a resumed session) OR learned from an earlier
    // session.create whose child has since died and been respawned (see
    // markChildGone). Preferring resume here is what lets a crashed/aborted/
    // watchdog-recovered turn continue the SAME agent session — keeping opencode's
    // replayed transcript and prior context — instead of silently forking a fresh
    // session. Falls back to create when there is no ref or the runtime can't
    // resume.
    const resumeRef = this.resumeRef ?? this.runtimeSessionRef;
    const created = resumeRef && this.capabilitiesRef.resume
      ? await this.command("session.resume", { workspace: this.cwd, sessionId: this.id, runtimeSessionRef: resumeRef, resumeRef })
      : await this.command("session.create", { workspace: this.cwd, sessionId: this.id });
    if (typeof created.runtimeSessionRef === "string") this.runtimeSessionRef = created.runtimeSessionRef;
    this.started = true;
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const wasStarted = this.started;
    await this.open();
    // Per-turn prepare + credential preflight, mirroring ProcessRuntime. Unlike a
    // fresh-process runtime, the protocol child is long-lived, so a credential
    // connected AFTER it spawned (a mid-session sign-in from the "Sign in to your
    // model" sheet) would never be materialized by start()'s one-shot prepare.
    // Re-run prepare here so e.g. Codex mints ~/.codex/auth.json from the just-
    // completed sign-in before this turn — the app-server reads the default auth
    // file, so it recovers on the next prompt instead of staying stuck on the
    // initial 401. Then preflight backstops the genuinely uncredentialed case with
    // an actionable error instead of an opaque upstream 401. ensureCodexAuth is
    // idempotent (it no-ops once auth.json exists), so the repeat is cheap.
    if (this.runtimeOptions.prepare || this.runtimeOptions.preflight) {
      const credentialEnv = this.runtimeOptions.credentials
        ? await buildAgentCredentialEnv(this.runtimeOptions.credentials, undefined, this.currentModelProvider).catch(() => ({}))
        : {};
      if (this.runtimeOptions.prepare) {
        this.prepareEnv =
          (await Promise.resolve(this.runtimeOptions.prepare({ ...process.env, ...this.runtimeOptions.env, ...credentialEnv })).catch(() => undefined)) ??
          this.prepareEnv;
      }
      const preflightError = this.runtimeOptions.preflight?.(
        { ...process.env, ...this.runtimeOptions.env, ...credentialEnv, ...this.prepareEnv },
        { provider: this.currentModelProvider },
      );
      if (preflightError) {
        this.streaming = false;
        const message = { role: "assistant", content: "", errorMessage: preflightError };
        this.messages.push(message);
        this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
        this.emit({ type: "session.error", error: preflightError });
        this.emit({ type: "message_end", message });
        this.emit({ type: "turn_end" });
        this.emit({ type: "agent_end", code: 1, signal: null });
        return;
      }
    }
    if (!wasStarted) this.emit({ type: "agent_start" });
    const prompt = text.trim();
    // Multimodal input: the daemon hands image attachments through PromptOptions
    // (the same ones native Claude receives). Forward them so a protocol agent
    // can act on images too, instead of them being silently dropped here. A
    // shim that can't see images just ignores the field. An images-only prompt
    // (empty text) is still a real turn, so don't bail when only images arrive.
    const images = (options?.images ?? []).map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
    if (!prompt && !images.length) return;
    // A `/name args` line matching an on-disk custom prompt runs the command by
    // sending its expanded body; the transcript still shows what the user typed.
    // Non-command lines pass through untouched. Best-effort — a read failure sends
    // the raw line.
    let textToSend: string;
    try {
      textToSend = this.runtimeOptions.slashCommands?.expand(this.cwd, prompt) ?? prompt;
    } catch {
      textToSend = prompt;
    }
    this.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    this.streaming = true;
    this.assistantText = "";
    this.reasoningText = "";
    this.stderrOutput = "";
    this.turnContent = [];
    this.turnTextFlushed = "";
    this.turnToolResults = [];
    this.toolDetailsByCallId.clear();
    await this.command("chat.send", {
      sessionId: this.id,
      runtimeSessionRef: this.runtimeSessionRef,
      text: textToSend,
      // Optional multimodal + streaming hints. Present only when the caller
      // supplied them, so a text-only turn keeps the exact payload it always had.
      ...(images.length ? { images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  async abort(): Promise<void> {
    const child = this.child;
    if (!child) {
      // No live turn process. A stuck `streaming` flag (a bug, or an event we
      // missed) would otherwise pin the session "working" forever and make it
      // un-resumable, so settle defensively: abort must ALWAYS leave the session
      // idle. Emitting agent_end lets the daemon clear its working state.
      if (this.streaming) {
        this.streaming = false;
        this.emit({ type: "agent_end", code: null, signal: null });
      }
      return;
    }
    // Ask the shim to stop the turn cleanly, then force-kill. A wedged agent
    // (opencode's ACP server stops responding) may ignore SIGTERM or block so
    // its 'close' never fires; without the SIGKILL escalation the child — and
    // therefore `isStreaming` — stays alive, leaving the turn unrecoverable.
    // Only command a live child, and swallow BOTH a sync throw (write() to an
    // already-dead child raises "Protocol agent is not running.") and an async
    // reject (a 5s timeout on a wedged shim) — the SIGKILL below is the real
    // guarantee, so an abort must never reject out of here as an unhandled error.
    if (this.started && this.child && !this.child.killed) {
      try { await this.command("session.abort", { sessionId: this.id }, 5_000); }
      catch { /* child gone or shim wedged — the force-kill below is authoritative */ }
    }
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 2_000).unref?.();
  }

  dispose(): void {
    void this.abort();
    this.emitter.removeAllListeners();
  }
}

export class ProtocolRuntime implements AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities = withExactCapabilitySurface({ toolInterception: false, modelSelection: false, packages: false, resume: false, fork: false });
  private sessions: ProtocolSession[] = [];

  constructor(private readonly options: ProtocolRuntimeOptions) {
    this.id = options.id || "bivy-agent-protocol";
    this.displayName = options.displayName || "Bivy Protocol Agent";
    // A resumable runtime advertises resume even before the handshake, so the UI
    // and takeover treat it as resumable up front (the ProcessRuntime convention).
    if (options.resumable) this.capabilities.resume = true;
    // A runtime that can write its own resumable store from portable history
    // (Codex's rollout) supports true cross-runtime replay forks INTO it.
    if (options.writeHistory) this.capabilities.forkHistoryImport = true;
    if (options.capabilities) Object.assign(this.capabilities, withExactCapabilitySurface({ ...this.capabilities, ...options.capabilities }));
  }

  listCatalog(): CatalogProvider[] {
    return this.options.catalog ?? [];
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new ProtocolSession(this.options, options.workspace, this.capabilities, options.toolInterceptor);
    await session.start();
    this.sessions.push(session);
    return { session };
  }

  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    const session = new ProtocolSession(this.options, options.workspace, this.capabilities, options.toolInterceptor, options.sessionFile);
    await session.start();
    if (!this.options.resumable && !this.capabilities.resume) {
      session.dispose();
      throw new Error(`${this.displayName} does not support resume.`);
    }
    this.sessions.push(session);
    return { session };
  }

  // Render a resumed session's prior turns without a live child (e.g. the daemon
  // hydrating history on reopen), when the runtime knows how to read them.
  readMessages(sessionFile: string): RuntimeMessage[] | undefined {
    return this.options.loadHistory?.(sessionFile);
  }

  /**
   * Materialise a cross-runtime fork's portable history into this agent's own
   * resumable store (fidelity "replayed"), delegating to the runtime-specific
   * `writeHistory` hook (Codex's `writeCodexRollout`). Only present in effect
   * when configured; the fork engine gates on `capabilities.forkHistoryImport`
   * and falls back to a seeded prompt if this throws.
   */
  async importHistoryForFork(
    history: ForkHistoryMessage[],
    ctx: ForkImportContext,
  ): Promise<{ sessionFile: string; id: string }> {
    if (!this.options.writeHistory) throw new Error(`${this.displayName} does not support history import.`);
    return this.options.writeHistory(history, ctx);
  }

  /** See ProtocolRuntimeOptions.discoverNativeSessions (issue #156). */
  async discoverNativeSessions(): Promise<DiscoveredNativeSession[]> {
    try {
      return (await this.options.discoverNativeSessions?.()) ?? [];
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.map((session) => ({ id: session.id, path: session.sessionFile, cwd: session.cwd, name: session.getName(), messageCount: session.getMessages().length }));
  }

  /**
   * Forget a session on a user-initiated delete: drop the in-memory handle so
   * listSessions stops returning it, and — for agents that persist transcripts in
   * their own store (Codex's rollout, reached via `deleteHistory`) — remove that
   * on-disk copy. Matches on the session id or its persisted resume ref. Returns
   * true if anything was removed.
   */
  async deleteSession(sessionId: string, sessionFile?: string): Promise<boolean> {
    let removed = false;
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i]!;
      if (s.id === sessionId || (sessionFile && s.sessionFile === sessionFile)) {
        try { s.dispose(); } catch { /* already torn down by the caller's close */ }
        this.sessions.splice(i, 1);
        removed = true;
      }
    }
    if (this.options.deleteHistory) {
      // Codex's rollout is keyed by the runtime session ref; try the id and the
      // provided sessionFile (either may be the rollout id depending on caller).
      for (const ref of new Set([sessionId, sessionFile].filter((v): v is string => Boolean(v)))) {
        try {
          this.options.deleteHistory(ref);
          removed = true;
        } catch {
          // Best-effort store cleanup — a missing/locked rollout must not fail the delete.
        }
      }
    }
    return removed;
  }
}
