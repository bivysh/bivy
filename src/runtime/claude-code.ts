// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Claude Code (Claude Agent SDK) adapter — a second concrete AgentRuntime.
//
// Maps Anthropic's `@anthropic-ai/claude-agent-sdk` onto the runtime-agnostic
// interface in ./types.ts so the daemon never sees an SDK type. Like pi.ts, this
// is the only place that touches the Claude Agent SDK.
//
// Design notes:
//   * One long-lived `query()` per session, driven by a streaming-input async
//     iterable (an AsyncQueue) so a session can take many prompts (multi-turn)
//     instead of spawning a fresh agent per prompt the way the generic CLI does.
//   * The guardian/approval hook is wired through the SDK's `canUseTool`
//     permission callback, which maps cleanly onto our generic `toolInterceptor`.
//   * The SDK is loaded with a dynamic import so it stays an *optional*
//     dependency: a Bivy install only needs it when this runtime is selected.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AgentCommand,
  AgentRuntime,
  AgentCredentialStore,
  CatalogProvider,
  ForkNativePayload,
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
  TuiLaunchSpec,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { depCacheEnv } from "../harness/dep-cache.js";
import os from "node:os";
import path from "node:path";
import { sandboxTier, claudePermissionModeFor, type SandboxTier } from "../harness/sandbox.js";
import { anthropicCredentialPreflight, describeAnthropicError, isAnthropicAuthError } from "./anthropic-preflight.js";
import { toModelInfo as sharedToModelInfo } from "./normalize.js";

/** Whether the standalone `claude` CLI (the TUI) is on PATH on this node. */
export function claudeCliAvailable(): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? ["claude"] : ["-v", "claude"], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

// Kept as a variable (not a string literal) so `tsc` treats the dynamic import
// as `any` and does not require the optional SDK to be installed to typecheck.
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

// AskUserQuestion is NOT handled here: it's a Bivy-owned feature that lives in
// the guardian tool-interceptor (see src/question.ts), so it works for every
// runtime with capabilities.toolInterception rather than being reimplemented per
// SDK. The interceptor is invoked from canUseTool below like any other tool.

// Fallback model list for the picker before the agent subprocess is up.
// getModels() is called to render the model picker (e.g. right after an
// OAuth sign-in, before the user sends anything), but the SDK's
// supportedModels() only runs once ensureStarted() has spawned the query on
// the first prompt. Until then this.models is empty and the picker would show
// nothing. These are the models a Claude Pro/Max subscription exposes; once
// the query is up, supportedModels() replaces them with the authoritative set.
const FALLBACK_MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", reasoning: true },
];

export interface ClaudeCodeRuntimeOptions {
  /** Default model alias/id passed to the SDK (e.g. "claude-opus-4-8"). */
  defaultModel?: string;
  /** Directory the SDK looks in to list/resume persisted sessions. */
  sessionsDir?: string;
  /** Extra environment variables handed to the agent subprocess. */
  env?: Record<string, string>;
  /**
   * Shared credential vault. When set, the Anthropic credential the node already
   * holds (Pi's auth.json — API key or Claude Pro/Max OAuth) is injected into the
   * SDK subprocess, so the user doesn't log in / paste a key again per agent.
   */
  credentials?: AgentCredentialStore;
  /** Provider id to resolve from the vault (default "anthropic"). */
  credentialProvider?: string;
  /** Per-session sandbox tier override (maps to the SDK permission mode). */
  sandbox?: SandboxTier;
  /** Override for the SDK loader (tests inject a fake `query()`); defaults to
   *  importing the real optional SDK package. */
  sdkLoader?: () => Promise<any>;
}

export function claudeRuntimeFromEnv(): ClaudeCodeRuntimeOptions {
  return {
    defaultModel: process.env.BIVY_CLAUDE_MODEL?.trim() || undefined,
    sessionsDir: process.env.BIVY_CLAUDE_SESSIONS_DIR?.trim() || undefined,
  };
}

/** True when `@anthropic-ai/claude-agent-sdk` is resolvable in this install. */
export function claudeSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

async function loadSdk(): Promise<any> {
  try {
    return await import(SDK_PACKAGE);
  } catch {
    throw new Error(
      `The claude-code-sdk runtime requires the "${SDK_PACKAGE}" package. Install it with: npm install ${SDK_PACKAGE}`,
    );
  }
}

/**
 * Single-producer async queue used as the SDK's streaming prompt input. Pushing a
 * message either satisfies a pending `next()` or buffers it; closing ends the
 * iterator so the underlying `query()` shuts down cleanly.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    let resolve: ((result: IteratorResult<T>) => void) | undefined;
    while ((resolve = this.resolvers.shift())) resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

/**
 * Build the composer's slash-command list from the SDK's system/init message.
 * `slash_commands` are the built-in + custom (.claude/commands) + plugin
 * commands; `skills` are exposed as "/name" too (the SDK runs a skill from a
 * matching slash). Names arrive without a leading slash, so we normalize to
 * "/name", drop blanks, and dedupe (slash_commands win over a same-named skill).
 * Exported for unit testing. Descriptions aren't in init, so names stand alone.
 */
export function claudeCommandsFromInit(message: any): AgentCommand[] {
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  const add = (raw: unknown) => {
    const base = typeof raw === "string" ? raw.trim().replace(/^\/+/, "") : "";
    if (!base) return;
    const name = `/${base}`;
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name });
  };
  const slash = message?.slash_commands;
  if (Array.isArray(slash)) for (const c of slash) add(c);
  const skills = message?.skills;
  if (Array.isArray(skills)) for (const s of skills) add(s);
  return out;
}

/** Order-insensitive equality on command names — so we only re-advertise (and
 *  re-render the composer menu) when the set actually changed. */
function sameCommands(a: AgentCommand[], b: AgentCommand[]): boolean {
  if (a.length !== b.length) return false;
  const names = new Set(b.map((c) => c.name));
  return a.every((c) => names.has(c.name));
}

function extractText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}

/** Plain text out of a `tool_result` content block's own `content` (a string or
 *  an array of text/image blocks) — mirrors `extractText`'s shape-handling. */
function toolResultText(block: any): string {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

/** Sums per-model token usage (SDK's ModelUsage) into a single totals object. */
export function sumModelUsage(modelUsage: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  for (const u of Object.values(modelUsage)) {
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    cacheRead += u.cacheReadInputTokens ?? 0;
    cacheWrite += u.cacheCreationInputTokens ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Pure mapping from the SDK's (experimental, unstable) get-usage response
 * shape into our runtime-agnostic UsageSnapshot. Kept separate from
 * ClaudeCodeSession.getUsage() so the mapping itself is unit-testable without
 * spinning up a real SDK query.
 */
export function mapUsageResponse(data: any): UsageSnapshot {
  const session = data?.session;
  const windows: UsageWindow[] = [];
  const rl = data?.rate_limits;
  if (rl) {
    const push = (label: string, w: { utilization?: number | null; resets_at?: string | null } | null | undefined) => {
      if (w) windows.push({ label, utilizationPct: w.utilization ?? null, resetsAt: w.resets_at ?? null });
    };
    push("5-hour", rl.five_hour);
    push("7-day", rl.seven_day);
    push("7-day (OAuth apps)", rl.seven_day_oauth_apps);
    push("7-day (Opus)", rl.seven_day_opus);
    push("7-day (Sonnet)", rl.seven_day_sonnet);
    for (const m of rl.model_scoped ?? []) push(m.display_name, m);
  }
  return {
    costUsd: session?.total_cost_usd,
    tokens: session?.model_usage ? sumModelUsage(session.model_usage) : undefined,
    plan: {
      subscriptionType: data?.subscription_type ?? null,
      windows,
    },
  };
}

function toModelInfo(model: any): ModelInfo {
  // Shared mapping (src/runtime/normalize.ts); Claude models default to the
  // anthropic provider when the record carries none.
  return sharedToModelInfo(model, { defaultProvider: "anthropic" });
}

function cleanSessionName(value: string) {
  return value
    .replace(/[\r\n"'`]/g, " ")
    .replace(/[\p{Control}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,:;\-–—]+$/g, "")
    .slice(0, 60)
    .trim();
}

/** The bearer we handed the SDK: the OAuth subscription token if present, else
 *  the API key. Used to tell whether the vault has rotated the credential since
 *  a query was spawned (the query's env is fixed at spawn — see spawnQuery). */
function authTokenFromEnv(env: Record<string, string>): string | undefined {
  return env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined;
}

function claudeUserContent(text: string, options?: PromptOptions): unknown {
  const images = options?.images ?? [];
  if (!images.length) return text;
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType || "image/png",
        data: image.data,
      },
    })),
  ];
}

function claudeProjectDirs(): string[] {
  return [
    process.env.CLAUDE_CONFIG_DIR,
    path.join(os.homedir(), ".claude"),
  ].filter((value): value is string => Boolean(value));
}

function findClaudeTranscript(sessionId: string): string | undefined {
  const fileName = `${sessionId}.jsonl`;
  for (const root of claudeProjectDirs()) {
    const projects = path.join(root, "projects");
    try {
      for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const candidate = path.join(projects, project.name, fileName);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore missing/unreadable Claude stores
    }
  }
  return undefined;
}

function loadClaudeTranscript(sessionId: string): RuntimeMessage[] {
  const file = findClaudeTranscript(sessionId);
  if (!file) return [];
  const messages: RuntimeMessage[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const role = entry?.message?.role ?? entry?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry?.message?.content ?? entry?.content;
      if (role === "user" && Array.isArray(content) && !content.some((block: any) => block?.type === "text" || block?.type === "tool_result")) continue;
      if (role === "assistant" && Array.isArray(content) && !content.some((block: any) => block?.type === "text" || block?.type === "tool_use" || block?.type === "thinking")) continue;
      if (typeof content !== "string" && !Array.isArray(content)) continue;
      messages.push({ role, content, timestamp: new Date(entry?.timestamp ?? entry?.createdAt ?? Date.now()).getTime() });
    }
  } catch {
    return messages;
  }
  return messages;
}

class ClaudeSession implements RuntimeSession {
  private query: any;
  // Re-created on every spawnQuery: the previous SDK query owns the old queue, so
  // a re-spawn (credential reload) must not share it. Not readonly for that reason.
  private input = new AsyncQueue<any>();
  private readonly emitter = new EventEmitter();
  private messages: RuntimeMessage[] = [];
  private streaming = false;
  private name?: string;

  private models: ModelInfo[] = [];
  private currentModel?: ModelInfo;
  private desiredModel?: string;

  /** Token used to `resume` an existing session; undefined for a fresh one. */
  private readonly resumeId?: string;
  /** The id we report; for new sessions we pin it via the SDK `sessionId` option. */
  readonly id: string;

  private currentText = "";
  private startedMessage = false;
  private readonly runningTools = new Set<string>();

  /** The bearer baked into the *currently running* query's env at spawn. A turn
   *  compares this against a freshly-resolved vault token to decide whether a
   *  credential reload is worth it (see restartWithFreshCredential). */
  private spawnedToken?: string;
  /** The user content of the in-flight turn, kept so a mid-flight credential
   *  reload can re-drive the interrupted prompt into the re-spawned query (the
   *  failed turn never reached disk, so resume alone wouldn't replay it). */
  private inFlightPrompt?: unknown;
  /** One reactive credential reload per turn — a second 401 after a refresh means
   *  the fresh token was also rejected, so surface it instead of looping. */
  private reloadedThisTurn = false;
  /** Guards restartWithFreshCredential against re-entrancy. */
  private reloading = false;

  /** The agent's own slash commands for this session, learned from the SDK's
   *  system/init message (slash_commands + skills). Empty until the first turn's
   *  init arrives; getCommands() exposes them and a `runtime.commands` event lets
   *  the daemon re-advertise once they're known. */
  private commands: AgentCommand[] = [];

  constructor(
    private readonly runtimeOptions: ClaudeCodeRuntimeOptions,
    public readonly cwd: string,
    private readonly toolInterceptor: ToolInterceptor | undefined,
    resumeId?: string,
  ) {
    this.resumeId = resumeId;
    this.id = resumeId ?? randomUUID();
    this.desiredModel = runtimeOptions.defaultModel;
    if (resumeId) this.messages = loadClaudeTranscript(resumeId);
  }

  /** Resume token handed back to the daemon; the session id doubles as the file. */
  get sessionFile(): string {
    return this.id;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * Resume this session in the `claude` CLI's interactive TUI. The SDK and CLI
   * share one on-disk store (~/.claude/projects/<cwd>/<sessionId>.jsonl) and our
   * session id *is* that sessionId, so `claude --resume <id>` in this worktree
   * reopens the exact conversation. Returns null if the CLI is not installed.
   * (Vault credentials are injected so the TUI uses the same auth as chat.)
   */
  async interactiveTuiCommand(): Promise<TuiLaunchSpec | null> {
    if (!claudeCliAvailable()) return null;
    const env = await this.resolveCredentialEnv().catch(() => ({}));
    return { command: "claude", args: ["--resume", this.sessionFile], env };
  }

  getMessages(): RuntimeMessage[] {
    return this.messages;
  }

  getCommands(): AgentCommand[] {
    return this.commands;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private emit(event: RuntimeEvent): void {
    this.emitter.emit("event", event);
  }

  private async ensureStarted(): Promise<void> {
    if (this.query) return;
    // First open resumes the stored token (undefined for a brand-new session);
    // a later credential reload resumes this.id (the conversation is on disk).
    await this.spawnQuery(this.resumeId);
  }

  /**
   * Spawn the SDK `query()` for this session and start consuming it. The vault
   * credential is resolved *here*, not once ahead of time, and baked into the
   * subprocess env; the bearer it produced is remembered on `spawnedToken` so a
   * later turn can tell whether the vault has since rotated it. `resumeId` is the
   * session to continue from: the stored resume token on a first open, or — when
   * re-spawning after a credential refresh — this session's own id, since the
   * conversation is already on disk by then.
   *
   * A fresh input queue is created on every spawn: the previous SDK query owns
   * (and may hold a pending read on) the old one, so reusing it would let a
   * re-driven prompt satisfy the dead query instead of the new one.
   */
  private async spawnQuery(resumeId?: string): Promise<void> {
    const sdk = await (this.runtimeOptions.sdkLoader ?? loadSdk)();
    this.input = new AsyncQueue<any>();

    // The SDK's "bypassPermissions" mode (what danger-full-access natively maps
    // to) auto-approves every tool call *before* the canUseTool callback runs —
    // so canUseTool never fires and the tool interceptor is skipped entirely,
    // which silently disables Bivy's governance AND its AskUserQuestion question
    // card (both ride the interceptor). Run those sessions in "default" mode and
    // blanket-allow tools in canUseTool instead: identical unrestricted access,
    // but the interceptor stays live.
    const nativeMode = claudePermissionModeFor(sandboxTier(this.runtimeOptions.sandbox));
    const fullAccess = nativeMode === "bypassPermissions";
    const permissionMode = fullAccess ? "default" : nativeMode;

    // Always defined (not gated on toolInterceptor): Bivy's interceptor may need
    // to service a tool (e.g. answer an AskUserQuestion), so this hook must exist
    // even when no other tools are gated.
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal?: AbortSignal; toolUseID?: string },
    ) => {
      if (this.toolInterceptor) {
        const decision = await this.toolInterceptor({ sessionId: this.id, toolName, input, signal: opts.signal });
        // Bivy answered/serviced the call itself — feed the result back without
        // running the tool. canUseTool has no success-result channel, so this
        // rides the deny message (the SDK returns it as the tool result); the
        // interceptor formats `result` as a plain statement, not an error.
        if (decision && decision.handled) {
          return { behavior: "deny", message: decision.result ?? "" };
        }
        if (decision && decision.block) {
          return { behavior: "deny", message: decision.reason ?? `Blocked ${toolName}` };
        }
      }
      // danger-full-access: no gating, just approve. Kept in "default" mode (not
      // via bypassPermissions) so canUseTool still runs the interceptor above.
      return { behavior: "allow", updatedInput: input };
    };

    // Start from the process env (the SDK's `env` replaces, not merges), layer in
    // any configured extras, then the shared-vault credential so one login at the
    // Bivy level serves this agent too. The vault wins over an ambient key.
    const env: Record<string, string> = { ...process.env, ...depCacheEnv(), ...this.runtimeOptions.env } as Record<string, string>;
    const credEnv = await this.resolveCredentialEnv();
    Object.assign(env, credEnv);
    this.spawnedToken = authTokenFromEnv(credEnv);

    const options: Record<string, unknown> = {
      cwd: this.cwd,
      includePartialMessages: true,
      // Native exec sandbox: map the node's tier to the SDK permission mode.
      // "default" keeps canUseTool gating risky tools (and, for danger-full-
      // access, blanket-allowing them — see fullAccess above); "plan" makes a
      // read-only session. We never pass "bypassPermissions": it would skip
      // canUseTool and silently break AskUserQuestion.
      permissionMode,
      canUseTool,
      env,
    };
    if (resumeId) options.resume = resumeId;
    else options.sessionId = this.id;
    if (this.desiredModel) options.model = this.desiredModel;

    const q = sdk.query({ prompt: this.input, options });
    this.query = q;
    void this.consume(q);

    // Best-effort: populate the model picker once the agent is up.
    if (typeof q.supportedModels === "function") {
      q.supportedModels()
        .then((models: any[]) => {
          this.models = (models ?? []).map(toModelInfo);
        })
        .catch(() => {});
    }
  }

  /**
   * Tear down the running query and re-spawn it resuming the same session, using
   * a freshly-resolved vault credential (Pi's AuthStorage auto-refreshes an
   * expired OAuth token, so re-resolving yields a live bearer). A long-lived
   * query bakes its token in at spawn and cannot pick up a rotated one any other
   * way, so restarting is the reload.
   *
   * Returns true when the vault produced a *different* token (the restart is
   * worth it), false when it produced the same token or none — in which case the
   * caller should surface the auth error rather than loop, since another attempt
   * would fail identically (e.g. a revoked login, or a rotated refresh token this
   * node lost the race for — the same cross-consumer race codex-auth.ts notes).
   * Emits a "Refreshing credentials…" notice only when it actually restarts.
   */
  private async restartWithFreshCredential(): Promise<boolean> {
    if (this.reloading) return false;
    this.reloading = true;
    try {
      const credEnv = await this.resolveCredentialEnv().catch(() => ({} as Record<string, string>));
      const nextToken = authTokenFromEnv(credEnv);
      if (!nextToken || nextToken === this.spawnedToken) return false;
      this.emit({ type: "session.notice", level: "info", message: "Refreshing credentials…" });
      this.teardownQuery();
      await this.spawnQuery(this.resumeId ?? this.id);
      return true;
    } finally {
      this.reloading = false;
    }
  }

  /** Close the current query and its input queue so a re-spawn resuming the same
   *  id can replace them. Unlike dispose() this leaves the session live (emitter,
   *  pending questions, message history intact) — only the transport is swapped. */
  private teardownQuery(): void {
    const q = this.query;
    this.query = undefined;
    this.input.close();
    if (q?.close) {
      try {
        q.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Resolve the shared Anthropic credential (if any) and map it to the env vars
   * the Claude Agent SDK accepts: ANTHROPIC_API_KEY for an API key, or
   * CLAUDE_CODE_OAUTH_TOKEN for a Claude Pro/Max subscription token. Returns an
   * empty object when no vault is wired or no credential is configured, so the
   * SDK falls back to its own auth (ambient env / `claude` CLI login).
   */
  private async resolveCredentialEnv(): Promise<Record<string, string>> {
    const store = this.runtimeOptions.credentials;
    if (!store) return {};
    const provider = this.runtimeOptions.credentialProvider?.trim() || "anthropic";
    let cred;
    try {
      cred = await store.getCredential(provider);
    } catch {
      return {};
    }
    if (!cred) return {};
    const out: Record<string, string> = { ...(cred.env ?? {}) };
    if (cred.kind === "oauth") out.CLAUDE_CODE_OAUTH_TOKEN = cred.token;
    else out.ANTHROPIC_API_KEY = cred.token;
    return out;
  }

  private async consume(q: AsyncIterable<any>): Promise<void> {
    try {
      for await (const message of q) this.handle(message);
    } catch (error) {
      this.streaming = false;
      const raw = error instanceof Error ? error.message : String(error);
      // Mid-flight credential reload: a long-lived query bakes its OAuth token in
      // at spawn, so a turn that outlives the token fails here with a 401 even
      // though the vault holds a freshly-refreshed one. Re-spawn once with the
      // fresh credential and re-drive the interrupted prompt so the turn continues
      // instead of dying. Bounded to one attempt per turn (reloadedThisTurn), only
      // when a prompt is actually in flight, and only when the vault produced a
      // *different* token (else restartWithFreshCredential returns false and we
      // fall through to surfacing the error — no retry loop on a dead credential).
      if (isAnthropicAuthError(raw) && !this.reloadedThisTurn && this.inFlightPrompt !== undefined) {
        this.reloadedThisTurn = true;
        if (await this.restartWithFreshCredential()) {
          this.streaming = true;
          this.input.push({ type: "user", message: { role: "user", content: this.inFlightPrompt }, parent_tool_use_id: null });
          return; // the re-spawned query's consume() now drives the turn to completion.
        }
      }
      // Emit session.error (the toast path) — agent_end's `error` field is not
      // surfaced by the client, so without this a thrown SDK error (e.g. a 401)
      // stopped the turn silently. Auth failures get sign-in guidance appended.
      this.emit({ type: "session.error", error: describeAnthropicError(raw) });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", error: raw });
    }
  }

  private beginMessage(): void {
    if (this.startedMessage) return;
    this.startedMessage = true;
    this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
  }

  private handle(message: any): void {
    switch (message?.type) {
      case "stream_event": {
        const event = message.event;
        if (
          event?.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          this.beginMessage();
          this.currentText += event.delta.text;
          this.emit({ type: "message_update", message: { role: "assistant", content: this.currentText } });
        }
        break;
      }

      case "partial_assistant": {
        const text = extractText(message.message);
        if (text) {
          this.beginMessage();
          this.currentText = text;
          this.emit({ type: "message_update", message: { role: "assistant", content: text } });
        }
        break;
      }

      case "assistant": {
        const model = message.message?.model;
        if (model) this.currentModel = toModelInfo({ id: model });
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === "tool_use") {
            this.emit({ type: "tool_call", toolName: block.name, input: block.input, toolUseId: block.id });
          }
        }
        const text = extractText(message.message);
        // Persist the full assistant turn — text, reasoning, and tool_use blocks —
        // so re-opening a session shows what led to the answer, not just the final
        // prose. Keep the content array intact when present so the client can pair
        // tool_use blocks with the tool_result messages below; otherwise the plain
        // text is enough. The live stream still surfaces text via message_end.
        if (content.length || text) {
          this.messages.push({ role: "assistant", content: content.length ? content : text, timestamp: Date.now() });
        }
        if (text) {
          this.beginMessage();
          const finalized: RuntimeMessage = { role: "assistant", content: text, timestamp: Date.now() };
          this.emit({ type: "message_update", message: finalized });
          this.emit({ type: "message_end", message: finalized });
        }
        this.startedMessage = false;
        this.currentText = "";
        break;
      }

      case "user": {
        // The SDK echoes tool results back as user-role messages holding
        // tool_result blocks. Persist those (matched to the tool_use blocks above
        // by tool_use_id) so a re-opened transcript can show each call's output.
        // Guard on tool_result so we never double-store the user's own prompt,
        // which prompt() already appended.
        const userContent = message.message?.content;
        const toolResults = Array.isArray(userContent) ? userContent.filter((b: any) => b?.type === "tool_result") : [];
        if (toolResults.length) {
          this.messages.push({ role: "user", content: userContent, timestamp: Date.now() });
          // Without this, a tool call's activity card in the transcript never
          // learns its call finished — nothing else translates this message
          // into a "result"-kind event, so `applyStreamEvent` (packages/core/
          // src/store.ts) falls through its default case and the card's status
          // stays "running" (spinner) for the rest of the session. `tool_progress`
          // pings cover *some* long-running tools but every tool completes via
          // this echo, so it's the one path that must flip every card to "done".
          for (const block of toolResults) {
            this.runningTools.delete(String(block.tool_use_id));
            this.emit({ type: "tool_result", toolUseId: block.tool_use_id, result: toolResultText(block), isError: Boolean(block.is_error) });
          }
        }
        this.emit({ type: "user", raw: message });
        break;
      }

      case "tool_progress": {
        // The SDK's SDKToolProgressMessage carries no `status`/`output` field —
        // it's purely a still-running elapsed-time ping for long-lived tools
        // (the previous `message.status === "running"` check always read
        // `undefined`, so every ping was mis-treated as completion, prematurely
        // flipping the activity card to "done" mid-tool). Completion is now
        // reported once, reliably, by the tool_result echo in `case "user"`
        // above — this case only ever means "still running".
        const toolUseId: string = message.tool_use_id;
        const type: RuntimeEvent["type"] = this.runningTools.has(toolUseId) ? "tool_execution_update" : "tool_execution_start";
        this.runningTools.add(toolUseId);
        this.emit({ type, toolName: message.tool_name, toolUseId, input: { elapsedSeconds: message.elapsed_time_seconds } });
        break;
      }

      case "result": {
        this.streaming = false;
        this.startedMessage = false;
        this.currentText = "";
        // Turn completed — the prompt is on disk now, so drop the copy kept for a
        // mid-flight reload re-drive (see inFlightPrompt / consume's catch).
        this.inFlightPrompt = undefined;
        if (message.subtype && message.subtype !== "success") {
          this.emit({ type: "tool_result", error: message.subtype, message: message.result });
        }
        this.emit({ type: "turn_end" });
        // Cost/token/plan-quota totals are read via getUsage() (backed by the
        // SDK's usage_EXPERIMENTAL... control request), not forwarded here.
        this.emit({ type: "agent_end", subtype: message.subtype });
        break;
      }

      case "system": {
        // The SDK's system/init reports this session's available slash commands
        // (built-ins, custom .claude/commands, plugins) and skills. Capture them
        // so getCommands() can offer them in the composer; the SDK interprets a
        // leading-slash prompt itself, so forwarding "/name" from chat runs it.
        // They're only known once init arrives (after the first turn starts), so
        // emit `runtime.commands` to let the daemon re-advertise capabilities.
        if (message?.subtype === "init") {
          const next = claudeCommandsFromInit(message);
          if (next.length && !sameCommands(next, this.commands)) {
            this.commands = next;
            this.emit({ type: "runtime.commands", commands: next });
          }
        }
        this.emit({ type: String(message?.type ?? "unknown"), raw: message });
        break;
      }

      default:
        // user/tool-result echoes, status, etc. — forwarded for debugging but
        // not part of busy/idle tracking.
        this.emit({ type: String(message?.type ?? "unknown"), raw: message });
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const prompt = text.trim();
    const content = claudeUserContent(prompt, options);
    const hasImages = Boolean(options?.images?.length);
    if (!prompt && !hasImages) return;
    // Credential preflight (first turn only): if no Anthropic credential will
    // reach the SDK, surface an actionable message instead of letting it spawn
    // and fail its first request with an opaque `401 Unauthorized`.
    if (!this.query) {
      const env = { ...process.env, ...depCacheEnv(), ...this.runtimeOptions.env, ...(await this.resolveCredentialEnv().catch(() => ({}))) } as Record<string, string>;
      const preflightError = anthropicCredentialPreflight(env);
      if (preflightError) {
        this.messages.push({ role: "user", content: hasImages ? content : prompt, timestamp: Date.now() });
        this.emit({ type: "agent_start" });
        this.emit({ type: "turn_start" });
        this.emit({ type: "session.error", error: preflightError });
        this.emit({ type: "turn_end" });
        this.emit({ type: "agent_end" });
        return;
      }
    }
    await this.ensureStarted();
    // Proactive reload at the turn boundary: the query's bearer is fixed at spawn,
    // so if the vault has rotated it since (commonly: a parallel session refreshed
    // the shared OAuth token, or it simply expired while this session sat idle),
    // restart now with the fresh one instead of spending a stale token and 401ing.
    // Only between turns (never mid-stream — that would drop an in-flight turn),
    // and a no-op unless the token actually changed (see restartWithFreshCredential).
    if (this.query && !this.streaming) await this.restartWithFreshCredential();
    this.messages.push({ role: "user", content: hasImages ? content : prompt, timestamp: Date.now() });
    this.reloadedThisTurn = false;
    this.inFlightPrompt = content;
    this.streaming = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async abort(): Promise<void> {
    if (this.query?.interrupt) {
      try {
        await this.query.interrupt();
      } catch {
        // Best-effort; the stream may already be idle.
      }
    }
    this.streaming = false;
  }

  dispose(): void {
    // query.close() aborts the SDK's in-flight canUseTool control requests,
    // whose AbortSignal is forwarded to Bivy's tool interceptor — so a pending
    // AskUserQuestion (owned by the daemon's QuestionManager) settles via that
    // abort. The daemon also cancels a session's questions on teardown as a
    // belt-and-suspenders (see server.ts), so nothing depends on this alone.
    this.input.close();
    if (this.query?.close) {
      try {
        this.query.close();
      } catch {
        // ignore
      }
    }
    this.emitter.removeAllListeners();
  }

  getModels(): ModelInfo[] {
    // Before the query is up (or if supportedModels() failed/returned nothing)
    // fall back to the known lineup so the picker is never empty.
    return this.models.length ? this.models : FALLBACK_MODELS;
  }

  getCurrentModel(): ModelInfo | undefined {
    if (this.currentModel) return this.currentModel;
    if (this.desiredModel) return toModelInfo({ id: this.desiredModel });
    return undefined;
  }

  async setModel(provider: string, id: string): Promise<void> {
    this.desiredModel = id;
    this.currentModel = toModelInfo({ provider, id });
    if (this.query?.setModel) await this.query.setModel(id);
  }

  /**
   * Cost/token totals plus, for a claude.ai OAuth session, plan rate-limit
   * utilization (how much of the 5-hour/7-day window is used). Backed by the
   * SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` —
   * explicitly unstable, so this fails soft (returns undefined) rather than
   * ever breaking the session if the shape changes or the call throws.
   */
  async getUsage(): Promise<UsageSnapshot | undefined> {
    const fn = this.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== "function") return undefined;
    try {
      return mapUsageResponse(await fn.call(this.query));
    } catch {
      return undefined;
    }
  }

  getName(): string | undefined {
    return this.name;
  }

  setName(name: string): void {
    this.name = name;
  }

  async suggestName(firstPrompt: string): Promise<string | undefined> {
    const prompt = firstPrompt.trim();
    if (!prompt) return undefined;

    const env = { ...process.env, ...depCacheEnv(), ...this.runtimeOptions.env, ...(await this.resolveCredentialEnv()) } as Record<string, string>;
    const apiKey = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!apiKey) return undefined;

    // Claude Pro/Max OAuth tokens are only authorized for Claude Code: a raw
    // /v1/messages call whose first system block isn't the Claude Code identity
    // is rejected (non-200), which silently dropped session naming back to the
    // first-line fallback. API keys have no such restriction. Send the identity
    // as the first system block for OAuth so the naming instruction survives.
    const useOAuth = !env.ANTHROPIC_API_KEY;
    const namingInstruction = "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.";
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(useOAuth
          ? { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
          : { "x-api-key": apiKey }),
      },
      body: JSON.stringify({
        model: this.desiredModel || "claude-3-5-haiku-latest",
        max_tokens: 24,
        temperature: 0.2,
        system: useOAuth
          ? [
              { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
              { type: "text", text: namingInstruction },
            ]
          : namingInstruction,
        messages: [{ role: "user", content: `Create a short title for this coding-agent session using the full first message below:\n\n${prompt.slice(0, 4000)}` }],
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (json.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
    return cleanSessionName(text) || undefined;
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = "claude-code-sdk";
  readonly displayName = "Claude Code SDK";
  readonly capabilities: RuntimeCapabilities = {
    toolInterception: true,
    modelSelection: true,
    packages: false,
    resume: true,
    fork: true,
    // Only offer the chat<->TUI hand-off when the `claude` CLI is on PATH.
    interactiveTui: claudeCliAvailable(),
    usageReporting: true,
    // The on-disk jsonl transcript can be exported and re-materialised on another
    // node under a fresh session id, so a claude->claude fork is full fidelity.
    forkTransport: true,
  };

  private readonly sessions: ClaudeSession[] = [];

  constructor(private readonly options: ClaudeCodeRuntimeOptions = {}) {}

  /** Claude Code runs Anthropic models; the authoritative list comes from the
   *  live query per session, so the session-less catalog is the known lineup. */
  listCatalog(): CatalogProvider[] {
    return [{ id: "anthropic", name: "Anthropic", oauth: true, models: FALLBACK_MODELS }];
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new ClaudeSession(this.options, options.workspace, options.toolInterceptor);
    this.sessions.push(session);
    return { session };
  }

  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    const session = new ClaudeSession(this.options, options.workspace, options.toolInterceptor, options.sessionFile);
    this.sessions.push(session);
    return {
      session,
      warning: "Resumed Claude Code session history is replayed by the agent on the next turn; prior messages are not preloaded.",
    };
  }

  /**
   * Read a session's transcript from Claude's on-disk store without constructing
   * a live session. `sessionFile` is the resume token — a Claude session id (the
   * runtime resumes by id, not path). This is exactly the read a resumed
   * ClaudeSession does in its constructor (`this.messages = loadClaudeTranscript`),
   * so the fast open path renders identically to the eventual live session. Empty
   * when the transcript isn't on disk (e.g. BIVY_CLAUDE_SESSIONS_DIR unset), which
   * the caller treats as "nothing to fast-paint" and falls back to a full open.
   */
  readMessages(sessionFile: string): RuntimeMessage[] | undefined {
    try {
      return loadClaudeTranscript(sessionFile);
    } catch {
      return undefined;
    }
  }

  /**
   * Export a claude session for a same-runtime fork: the raw jsonl transcript
   * (Claude's own on-disk format), located by session id across the project
   * stores. Undefined when the transcript isn't on disk. Reconstructed by
   * `importForFork` on the destination node.
   */
  exportForFork(sessionFile: string): ForkNativePayload | undefined {
    const file = findClaudeTranscript(sessionFile);
    if (!file) return undefined;
    try {
      const jsonl = fs.readFileSync(file, "utf8");
      return { runtimeId: this.id, kind: "claude-jsonl", data: { jsonl, sourceId: sessionFile } };
    } catch {
      return undefined;
    }
  }

  /**
   * Materialise an exported claude transcript into a fresh session on this node.
   * Writes the jsonl under the destination cwd's project dir with a NEW session
   * id (rewriting each entry's `sessionId`/`cwd` so `--resume <id>` and the SDK's
   * store both see a self-consistent conversation), and returns that id as the
   * resume ref. The source session is never touched.
   */
  async importForFork(
    payload: ForkNativePayload,
    ctx: { workspace: string; cwd: string },
  ): Promise<{ sessionFile: string; id: string }> {
    if (payload.runtimeId !== this.id || payload.kind !== "claude-jsonl") {
      throw new Error(`claude.importForFork: unexpected payload ${payload.runtimeId}/${payload.kind}`);
    }
    const jsonl = String((payload.data as { jsonl?: unknown })?.jsonl ?? "");
    const newId = randomUUID();
    const cwd = ctx.cwd || ctx.workspace;
    // Claude encodes the cwd into the project-dir name by replacing every
    // non-alphanumeric char with "-", e.g. "/home/u/p" -> "-home-u-p".
    const projectSlug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const root = claudeProjectDirs()[0] ?? path.join(os.homedir(), ".claude");
    const projectDir = path.join(root, "projects", projectSlug);
    fs.mkdirSync(projectDir, { recursive: true });
    const rewritten = jsonl
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const entry = JSON.parse(line);
          entry.sessionId = newId;
          if (entry.cwd) entry.cwd = cwd;
          return JSON.stringify(entry);
        } catch {
          return line; // preserve any line we can't parse rather than dropping it
        }
      })
      .join("\n");
    fs.writeFileSync(path.join(projectDir, `${newId}.jsonl`), rewritten ? `${rewritten}\n` : "");
    return { sessionFile: newId, id: newId };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const dir = this.options.sessionsDir;
    if (dir) {
      try {
        const sdk = await loadSdk();
        if (typeof sdk.listSessions === "function") {
          const sessions = await sdk.listSessions({ dir });
          return (sessions ?? []).map((s: any) => {
            const id = s.sessionId ?? s.id;
            const open = this.sessions.find((session) => session.id === id || session.sessionFile === s.path);
            return {
              id,
              path: s.path,
              cwd: s.cwd ?? dir,
              name: open?.getName() ?? s.name ?? s.title,
              created: s.created ?? s.createdAt,
              modified: s.modified ?? s.updatedAt,
              messageCount: s.messageCount,
              firstMessage: s.firstMessage ?? s.summary,
            };
          });
        }
      } catch {
        // Fall through to in-memory sessions if the SDK can't list from disk.
      }
    }
    return this.sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      name: session.getName(),
      messageCount: session.getMessages().length,
    }));
  }

  /**
   * Delete a session from Claude's own on-disk store. Without this, deleting a
   * Claude session in the app only clears Bivy's metadata + its sessionsDir file
   * — the transcript still sits in Claude's store (BIVY_CLAUDE_SESSIONS_DIR /
   * `~/.claude/projects/<cwd>/<id>.jsonl`), so the next listSessions re-surfaces
   * it and the sidebar row reappears. We remove the exact `.jsonl` the SDK lists
   * from so the delete finally sticks.
   */
  async deleteSession(sessionId: string, sessionFile?: string): Promise<boolean> {
    // Drop (and tear down) any in-memory handle so the fallback branch of
    // listSessions (used when no sessionsDir is set) can't re-advertise it, and a
    // still-live child doesn't outlive the delete.
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i]!;
      if (s.id === sessionId || (sessionFile && s.sessionFile === sessionFile)) {
        try { s.dispose(); } catch { /* already disposed by the caller's close */ }
        this.sessions.splice(i, 1);
      }
    }
    // Prefer the exact path the SDK reports (that's the file it would re-read on
    // the next list); fall back to locating the transcript by id across Claude's
    // project stores. `sessionFile` is Claude's resume token (an id), not a path,
    // so it can't be unlinked directly.
    let file: string | undefined;
    try {
      file = (await this.listSessions()).find((s) => s.id === sessionId)?.path;
    } catch {
      // SDK list failed — fall through to the on-disk id lookup below.
    }
    file ??= findClaudeTranscript(sessionId);
    if (!file) return false;
    try {
      await fs.promises.unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }
}
