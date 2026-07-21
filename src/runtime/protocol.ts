// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { buildAgentCredentialEnv } from "./credentials.js";
import type {
  AgentCommand,
  AgentRuntime,
  AgentCredentialStore,
  CatalogProvider,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  PromptOptions,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolInterceptor,
  UsageSnapshot,
} from "./types.js";
import { extractTokenUsage } from "./cli-parsers.js";

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
  /** Runtime-specific, side-effect-free title request (for example `codex exec --ephemeral`). */
  suggestName?: (firstPrompt: string, context: { cwd: string; model?: string }) => Promise<string | undefined>;
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

function capabilitiesFromHello(raw: unknown): RuntimeCapabilities {
  const c = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    toolInterception: c.toolInterception === true,
    modelSelection: c.modelSelection === true,
    packages: false,
    resume: c.resume === true,
    fork: false,
    commands: parseAgentCommands(c.commands),
  };
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
  private lastUsage?: UsageSnapshot;
  // Accumulate the current turn's tool calls/results so getMessages() keeps them
  // in history — re-opening a session then shows what the agent actually did, not
  // just its final text. Cleared at the start/end of each turn.
  private turnToolUses: Array<Record<string, unknown>> = [];
  private turnToolResults: Array<Record<string, unknown>> = [];

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
    const child = spawn(this.runtimeOptions.command, this.runtimeOptions.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...this.runtimeOptions.env, ...credentialEnv },
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.emit({ type: "tool_execution_update", toolName: "stderr", input: { output: chunk.toString("utf8").slice(-4000) } }));
    // The agent's stdin pipe can break (EPIPE) when the shim exits mid-turn — for
    // example a dispose()/abort() racing an in-flight write (a tool.decision reply,
    // a chat.send). Node emits that as an 'error' on the stdin socket; with no
    // listener it is fatal to the whole daemon. Absorb it: the child is already
    // gone, so mark the turn stopped and fail any pending commands instead of
    // crashing the process over a normal teardown race.
    child.stdin.on("error", (error) => { this.streaming = false; this.failAll(error instanceof Error ? error : new Error(String(error))); });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code, signal) => {
      this.streaming = false;
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
    if (type === "message.delta") {
      const text = String(msg.text ?? "");
      if (!this.assistantText) this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
      this.assistantText += text;
      this.emit({ type: "message_update", message: { role: "assistant", content: this.assistantText } });
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
      const message = { role: "assistant", content: this.assistantText };
      // Persist the assistant turn. When the turn used tools, store content blocks
      // (text + tool_use) plus a trailing user message carrying the tool_result
      // blocks, matched by tool_use_id — the same shape the PWA renders from live
      // streaming, so a re-opened transcript looks identical to what was on screen.
      // A tool-free turn keeps the plain-text form it always used.
      if (this.turnToolUses.length || this.turnToolResults.length) {
        const assistantContent: Array<Record<string, unknown>> = [];
        if (this.assistantText) assistantContent.push({ type: "text", text: this.assistantText });
        assistantContent.push(...this.turnToolUses);
        if (assistantContent.length) this.messages.push({ role: "assistant", content: assistantContent, timestamp: Date.now() });
        if (this.turnToolResults.length) this.messages.push({ role: "user", content: this.turnToolResults, timestamp: Date.now() });
      } else if (this.assistantText) {
        this.messages.push(message);
      }
      this.emit({ type: "message_end", message });
      this.streaming = false;
      this.assistantText = "";
      this.reasoningText = "";
      this.turnToolUses = [];
      this.turnToolResults = [];
      this.emit({ type: "agent_end" });
      return;
    }
    if (type === "session.error") {
      this.streaming = false;
      this.reasoningText = "";
      this.turnToolUses = [];
      this.turnToolResults = [];
      this.emit({ type: "session.error", error: String(msg.error || "Protocol agent error") });
      this.emit({ type: "agent_end" });
      return;
    }
    if (type === "tool.call") {
      this.turnToolUses.push({
        type: "tool_use",
        id: String(msg.toolCallId || msg.id || ""),
        name: String(msg.name || "tool"),
        input: msg.input ?? {},
      });
    }
    if (type === "tool.call" && this.capabilitiesRef.toolInterception && this.toolInterceptor) {
      const toolCallId = String(msg.toolCallId || "");
      const toolName = String(msg.name || "tool");
      this.emit({ type: "tool_call", toolName, input: msg.input, toolCallId });
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
    if (type === "tool.result") {
      this.turnToolResults.push({
        type: "tool_result",
        tool_use_id: String(msg.toolCallId || msg.tool_use_id || msg.id || ""),
        content: msg.result ?? msg.output ?? msg.content ?? msg.text ?? "",
      });
      this.emit({ type: "tool_result", toolName: String(msg.name || "tool"), result: msg });
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

  async open(): Promise<void> {
    await this.start();
    if (this.started) return;
    const created = this.resumeRef
      ? await this.command("session.resume", { workspace: this.cwd, sessionId: this.id, runtimeSessionRef: this.resumeRef, resumeRef: this.resumeRef })
      : await this.command("session.create", { workspace: this.cwd, sessionId: this.id });
    if (typeof created.runtimeSessionRef === "string") this.runtimeSessionRef = created.runtimeSessionRef;
    this.started = true;
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const wasStarted = this.started;
    await this.open();
    if (!wasStarted) this.emit({ type: "agent_start" });
    const prompt = text.trim();
    // Multimodal input: the daemon hands image attachments through PromptOptions
    // (the same ones native Claude receives). Forward them so a protocol agent
    // can act on images too, instead of them being silently dropped here. A
    // shim that can't see images just ignores the field. An images-only prompt
    // (empty text) is still a real turn, so don't bail when only images arrive.
    const images = (options?.images ?? []).map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
    if (!prompt && !images.length) return;
    this.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    this.streaming = true;
    this.assistantText = "";
    this.reasoningText = "";
    this.turnToolUses = [];
    this.turnToolResults = [];
    await this.command("chat.send", {
      sessionId: this.id,
      runtimeSessionRef: this.runtimeSessionRef,
      text: prompt,
      // Optional multimodal + streaming hints. Present only when the caller
      // supplied them, so a text-only turn keeps the exact payload it always had.
      ...(images.length ? { images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    });
  }

  async abort(): Promise<void> {
    if (!this.child) return;
    if (this.started) await this.command("session.abort", { sessionId: this.id }, 5_000).catch(() => undefined);
    this.child.kill("SIGTERM");
  }

  dispose(): void {
    void this.abort();
    this.emitter.removeAllListeners();
  }
}

export class ProtocolRuntime implements AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities = { toolInterception: false, modelSelection: false, packages: false, resume: false, fork: false };
  private sessions: ProtocolSession[] = [];

  constructor(private readonly options: ProtocolRuntimeOptions) {
    this.id = options.id || "bivy-agent-protocol";
    this.displayName = options.displayName || "Bivy Protocol Agent";
    // A resumable runtime advertises resume even before the handshake, so the UI
    // and takeover treat it as resumable up front (the ProcessRuntime convention).
    if (options.resumable) this.capabilities.resume = true;
    if (options.capabilities) Object.assign(this.capabilities, options.capabilities);
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
