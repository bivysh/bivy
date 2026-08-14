// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pi integration bridge. The operator's installed Pi remains the user-facing
// agent/TUI; this module adapts Pi's SDK protocol to Bivy's AgentRuntime contract.
// It is isolated under src/agents so core registration has no Pi-specific path.
//
// The guardian/approval hook is wired here: a generic `toolInterceptor` passed in
// OpenSessionOptions is adapted to Pi's `pi.on("tool_call")` extension event.

import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  AgentSessionRuntime,
  ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashToolDefinition,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "../../runtime/pi-oauth.js";
import { toModelInfo as sharedToModelInfo } from "../../runtime/normalize.js";
import { provisionPiAuthJson } from "../../runtime/credential-provisioning.js";
import { isNativeOAuthProvider } from "../../runtime/oauth/model-oauth-providers.js";
import { bivySessionEnv } from "../../runtime/session-env.js";
import type {
  AgentCommand,
  AgentRuntime,
  CatalogProvider,
  ForkHistoryMessage,
  ForkImportContext,
  ForkNativePayload,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  PromptOptions,
  RuntimeCapabilities,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolInterceptor,
  ToolProvider,
  ToolResult,
  TuiLaunchSpec,
  UsageSnapshot,
} from "../../runtime/types.js";
import { withExactCapabilitySurface } from "../../runtime/types.js";
import { mapToolCall, mapToolResult } from "../../runtime/tool-call-map.js";
import { BackgroundShellTracker, createBackgroundAwareBashOperations } from "./background-shell.js";

/**
 * Extract Pi's own slash commands from a live AgentSession: extension commands
 * (`pi.registerCommand`, exposed via `extensionRunner.getRegisteredCommands()`),
 * prompt templates (`promptTemplates`), and skills (`/skill:name`). Pi stores
 * names without a leading slash, so we normalize to "/name"; duplicates are
 * dropped (first wins). Reads the SDK through loose accessors and swallows any
 * shape mismatch — this is display-only, so it degrades to an empty list rather
 * than throwing. Pure and exported so it's unit-testable without a live agent.
 */
export function piSessionCommands(session: unknown): AgentCommand[] {
  try {
    const s = session as any;
    const seen = new Set<string>();
    const out: AgentCommand[] = [];
    const add = (rawName: unknown, description: unknown) => {
      const base = typeof rawName === "string" ? rawName.trim().replace(/^\/+/, "") : "";
      if (!base) return;
      const name = `/${base}`;
      if (seen.has(name)) return;
      seen.add(name);
      out.push(typeof description === "string" && description.trim() ? { name, description: description.trim() } : { name });
    };
    const ext = s?.extensionRunner?.getRegisteredCommands?.();
    if (Array.isArray(ext)) for (const c of ext) add(c?.invocationName, c?.description);
    const templates = s?.promptTemplates;
    if (Array.isArray(templates)) for (const t of templates) add(t?.name, t?.description);
    const skills = s?._resourceLoader?.getSkills?.()?.skills;
    if (Array.isArray(skills)) for (const sk of skills) add(`skill:${sk?.name}`, sk?.description);
    return out;
  } catch {
    return [];
  }
}

/** The operator's Pi command; Bivy never launches a bundled private TUI. */
function resolvePiCommand(): string {
  return process.env.BIVY_PI_COMMAND?.trim() || "pi";
}

/** What PiSession.interactiveTuiCommand needs to relaunch this session's TUI. */
interface PiTuiLaunch {
  credsDir: string;
  piDir: string;
  sessionsDir: string;
  piCommand: string;
  credentialOwner: "agent" | "bivy";
  allowModelNetwork: boolean;
}

export interface PiRuntimeOptions {
  /** The node's shared credential vault dir (agent-neutral, `.bivy/credentials`). */
  credsDir: string;
  /** Pi agent directory (models.json, plaintext auth.json, sessions/, packages). */
  piDir: string;
  /** Directory holding session JSONL files. */
  sessionsDir: string;
  /** Agent-owned auth/config is used by packaged integrations; legacy callers may use Bivy's vault. */
  credentialOwner?: "agent" | "bivy";
  /** Disable remote model-catalog refreshes for deterministic/offline callers. Defaults to true. */
  allowModelNetwork?: boolean;
}

function toModelInfo(model: any, configured?: boolean): ModelInfo {
  // Shared mapping (src/runtime/normalize.ts). Pi models always carry
  // provider/id/name, so the lenient fallbacks are no-ops here; `input` and
  // `configured` pass through as before.
  const info = sharedToModelInfo(model, configured != null ? { configured } : {});
  if (info.input === undefined) info.input = model.input;
  return info;
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

/** Builds the Pi extension that bridges tool calls to a generic interceptor. */
function guardianFactory(sessionId: string, interceptor?: ToolInterceptor): ExtensionFactory {
  return function guardian(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
      if (!interceptor) return;
      const decision = await interceptor({ sessionId, toolName: event.toolName, input: event.input, signal: ctx.signal });
      // Bivy serviced the call itself (e.g. answered an AskUserQuestion): don't
      // run the tool; hand the result back. Pi's tool_call hook can only supply
      // content through the block channel (agent-loop turns `reason` into the
      // tool result), so `handled` and `block` share the wire here — the guardian
      // keeps them semantically distinct (no tool.blocked broadcast for handled).
      if (decision && decision.handled) {
        return { block: true, reason: decision.result ?? "" };
      }
      if (decision && decision.block) {
        return { block: true, reason: decision.reason ?? `Blocked ${event.toolName}` };
      }
    });
  };
}

/**
 * Binds a runtime-agnostic ToolProvider (Bivy integrations, MCP, …) into a Pi
 * session by registering each ToolSpec as a Pi tool whose `execute` routes to
 * `provider.invoke`. This is the ONLY Pi-specific knowledge about node-hosted
 * tools; the provider itself — and everything upstream (server.ts, the RPC link,
 * the agent service) — is agent-agnostic. The provider owns the implementation
 * and credentials (locally in-process, or on the daemon via reverse RPC when the
 * session is remote), so Pi is treated as just another agent that happens to know
 * how to expose provided tools.
 */
function toolProviderFactory(provider: ToolProvider): ExtensionFactory {
  // Adapt a generic ToolResult to Pi's tool-result shape (content always present,
  // text blocks). This mapping is the ONLY place the agent-agnostic ToolResult
  // meets Pi's SDK types.
  const toPiResult = (result: ToolResult) => ({
    content: (result.content ?? []).map((c) => ({ type: "text" as const, text: c.text ?? "" })),
    details: (result.details ?? {}) as Record<string, unknown>,
    ...(result.isError ? { isError: true } : {}),
  });
  return function providedTools(pi: ExtensionAPI) {
    for (const spec of provider.list()) {
      pi.registerTool({
        name: spec.name,
        label: spec.label ?? spec.name,
        description: spec.description ?? spec.name,
        promptSnippet: spec.promptSnippet ?? spec.description ?? spec.name,
        parameters: spec.parameters as any,
        async execute(toolCallId: string, params: any, signal?: AbortSignal) {
          try {
            return toPiResult(await provider.invoke(spec.name, toolCallId, params, signal));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return toPiResult({ content: [{ type: "text", text: `${spec.name} failed: ${message}` }], isError: true });
          }
        },
      });
    }
  };
}

class PiSession implements RuntimeSession {
  private readonly toolDetails = new Map<string, ReturnType<typeof mapToolCall>>();

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly tui: PiTuiLaunch,
    private readonly backgroundShells: BackgroundShellTracker,
  ) {}

  private get session(): AgentSession {
    return this.runtime.session;
  }

  get id(): string {
    return this.session.sessionManager.getSessionId();
  }

  get cwd(): string {
    return this.runtime.cwd || this.session.sessionManager.getCwd();
  }

  get sessionFile(): string | undefined {
    return this.session.sessionManager.getSessionFile();
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  /**
   * Resume this exact session in pi's interactive TUI. Points the CLI at the
   * daemon's own agent dir and session store (same files the SDK reads) and
   * resumes by session file, so the TUI shows the live conversation. Returns
   * null for an unsaved session (nothing to resume yet).
   *
   * This is also the one place PiSession spawns a subprocess Bivy itself
   * configures, so it's where BIVY_SESSION_ID (see session-env.ts) is injected
   * for this adapter. It does NOT cover the live-chat case (an agent turn
   * running pi's own bash tool): pi's SDK runs its agent loop in-process and
   * builds that tool's subprocess env internally, with no hook for a host to
   * inject its own vars. That gap is closed differently — the SDK's bash tool
   * already exposes PI_SESSION_ID to every command it runs, and that id IS the
   * Bivy session id for a pi session (this.id reads the exact same
   * SessionManager the SDK reads it from) — so `bivy attach` accepts
   * PI_SESSION_ID as an equivalent fallback (see bin/attach-session-id.mjs).
   */
  async interactiveTuiCommand(): Promise<TuiLaunchSpec | null> {
    const file = this.sessionFile;
    if (!file) return null;
    // Pi's own TUI reads its plaintext auth.json store, so project the vault to
    // disk (refreshed) for the hand-off. Best-effort: an empty auth.json just
    // means the TUI prompts for login (which we ingest back on the next sync).
    if (this.tui.credentialOwner === "bivy") {
      await provisionPiAuthJson(this.tui.credsDir, this.tui.piDir).catch(() => {});
    }
    return {
      command: this.tui.piCommand,
      args: ["--session", file, "--session-dir", this.tui.sessionsDir],
      env: { PI_CODING_AGENT_DIR: this.tui.piDir, ...bivySessionEnv(this.id) },
    };
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.session.prompt(text, options as any);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    this.backgroundShells.dispose();
    void this.runtime.dispose();
  }

  getMessages(): RuntimeMessage[] {
    return this.session.state.messages as unknown as RuntimeMessage[];
  }

  subscribe(listener: (event: any) => void): () => void {
    const unsubscribeBackground = this.backgroundShells.subscribe((count) => {
      listener({ type: "background_tasks_changed", count });
    });
    const unsubscribeSession = this.session.subscribe((event: any) => {
      const type = String(event?.type ?? "");
      const callId = String(event?.toolCallId ?? event?.toolUseId ?? event?.tool_use_id ?? event?.id ?? "");
      if (type === "tool_call" || type === "tool_execution_start") {
        const name = String(event?.toolName ?? event?.name ?? "tool");
        const input = event?.input ?? event?.args ?? {};
        const detail = mapToolCall(name, input, { provider: "pi", protocol: "sdk" });
        if (detail && callId) this.toolDetails.set(callId, detail);
        listener(detail ? { ...event, detail } : event);
        return;
      }
      if (type === "tool_result" || type === "tool_execution_end") {
        const prior = this.toolDetails.get(callId);
        const detail = prior ? { ...prior, result: mapToolResult(event?.result ?? event?.output, Boolean(event?.error)) } : undefined;
        listener(detail ? { ...event, detail } : event);
        return;
      }
      listener(event);
    });
    return () => {
      unsubscribeBackground();
      unsubscribeSession();
    };
  }

  /**
   * Pi's own slash commands for this session: extension commands (pi.register
   * Command), prompt templates, and skills (/skill:name). The composer offers
   * these in autocomplete; invoking one forwards "/name args" as a prompt, which
   * Pi's prompt() executes via _tryExecuteExtensionCommand instead of sending to
   * the model. Names are normalized to a leading "/" (Pi stores them without
   * one). Best-effort: any SDK shape change degrades to an empty list, never a
   * throw — this is display-only. Bivy's own control commands (/model, /new, …)
   * win a name collision in the composer, so we don't filter them here.
   */
  getCommands(): AgentCommand[] {
    return piSessionCommands(this.session);
  }

  /**
   * The connected/available models for the picker.
   *
   * `ModelRuntime.getAvailable()` re-resolves provider auth against Bivy's
   * credential store on each call, so a provider the user signs into *after* the
   * session started (e.g. an OpenAI/ChatGPT OAuth login while a Claude session is
   * open) surfaces here without a restart — no stale in-memory snapshot to
   * reload. Async because that resolution reads the store.
   */
  async getModels(): Promise<ModelInfo[]> {
    const models = await this.session.modelRuntime.getAvailable();
    return models.map((model) => toModelInfo(model, true));
  }

  /**
   * Every model Pi knows about — built-in and custom, regardless of whether
   * its provider currently has auth configured — so the model picker can
   * offer unconnected providers with an inline "connect" action (#390). Each
   * entry's `configured` flag comes straight from hasConfiguredAuth(), the
   * same check setModel() already gates on.
   */
  async getAllModels(): Promise<ModelInfo[]> {
    const runtime = this.session.modelRuntime;
    // Refresh availability first so `hasConfiguredAuth` reflects current creds.
    await runtime.getAvailable();
    return runtime.getModels().map((model) => toModelInfo(model, runtime.hasConfiguredAuth(model.provider)));
  }

  /** Reload the projected models.json in-place so a live session immediately
   * sees custom endpoints added after that session was created. */
  async refreshModels(): Promise<void> {
    const controller = this.tui.allowModelNetwork ? new AbortController() : undefined;
    const timeout = controller ? setTimeout(() => controller.abort(), 15_000) : undefined;
    try {
      await this.session.modelRuntime.refresh({
        allowNetwork: this.tui.allowModelNetwork,
        signal: controller?.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getCurrentModel(): ModelInfo | undefined {
    const model = this.session.model;
    return model ? toModelInfo(model) : undefined;
  }

  async setModel(provider: string, id: string): Promise<void> {
    const runtime = this.session.modelRuntime;
    await runtime.getAvailable();
    const model = runtime.getModel(provider, id);
    if (!model || !runtime.hasConfiguredAuth(provider)) {
      throw new Error("Model is not available on this node.");
    }
    await this.session.setModel(model);
  }

  getThinkingLevel(): string | undefined {
    try {
      return (this.session as any).thinkingLevel;
    } catch {
      return undefined;
    }
  }

  setThinkingLevel(level: string): void {
    try {
      (this.session as any).setThinkingLevel?.(level);
    } catch {
      // ignore if runtime does not support
    }
  }

  getAvailableThinkingLevels(): string[] {
    try {
      const fn = (this.session as any).getAvailableThinkingLevels;
      return typeof fn === "function" ? fn.call(this.session) : ["off", "minimal", "low", "medium", "high"];
    } catch {
      return ["off", "minimal", "low", "medium", "high"];
    }
  }

  supportsThinking(): boolean {
    try {
      const fn = (this.session as any).supportsThinking;
      if (typeof fn === "function") return !!fn.call(this.session);
      const cur = this.getCurrentModel();
      return !!cur?.reasoning;
    } catch {
      return !!this.getCurrentModel()?.reasoning;
    }
  }

  getName(): string | undefined {
    return this.session.sessionName ?? this.session.sessionManager.getSessionName() ?? undefined;
  }

  /**
   * Cost/token totals from Pi's own session stats. Pi has no concept of a
   * metered OAuth/subscription plan quota (unlike Claude Code SDK), so `plan`
   * is always left undefined here.
   */
  async getUsage(): Promise<UsageSnapshot | undefined> {
    try {
      const stats = this.session.getSessionStats();
      return {
        costUsd: stats.cost,
        tokens: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
          total: stats.tokens.total,
        },
      };
    } catch {
      return undefined;
    }
  }

  setName(name: string): void {
    this.session.setSessionName(name);
  }

  async suggestName(firstPrompt: string): Promise<string | undefined> {
    const prompt = firstPrompt.trim();
    if (!prompt) return undefined;
    const model = this.session.model;
    if (!model) return undefined;
    const auth = await this.session.modelRuntime.getAuth(model);
    if (!auth) return undefined;

    const response = await completeSimple(
      model,
      {
        systemPrompt:
          "Name chat sessions from the user's entire first message, not just its first line. Return only a concise title, 2-6 words. No quotes, punctuation, prefixes, or explanations.",
        messages: [
          { role: "user", content: `Create a short title for this coding-agent session using the full first message below:\n\n${prompt.slice(0, 4000)}`, timestamp: Date.now() },
        ],
      },
      { apiKey: auth.auth.apiKey, headers: auth.auth.headers, env: auth.env, temperature: 0.2, maxTokens: 24, reasoning: "minimal", sessionId: `${this.id}:name` },
    );

    const text = response.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join(" ");
    const name = cleanSessionName(text);
    return name || undefined;
  }
}

export class PiRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly capabilities: RuntimeCapabilities = withExactCapabilitySurface({
    toolInterception: true,
    modelSelection: true,
    packages: true,
    resume: true,
    fork: false,
    // pi resumes by session-file path (under the node's sessions dir), so the
    // daemon applies its path-traversal guard to these refs.
    sessionRefIsPath: true,
    // pi's TUI ships with the node, so the chat<->TUI hand-off is always offered.
    interactiveTui: true,
    usageReporting: true,
    // pi transcripts are structured messages that round-trip through the session
    // store, so a pi->pi fork is full fidelity (see exportForFork/importForFork).
    forkTransport: true,
    // pi can also stand up a session from portable {role,text} history, so a fork
    // FROM another agent INTO pi is a true replay, not a seeded summary.
    forkHistoryImport: true,
    // The pi-coding-agent SDK implements both explicitly: prompting mid-turn
    // with no streamingBehavior hint throws, forcing every caller to choose.
    streamingBehaviors: ["steer", "followUp"],
  });

  constructor(private readonly options: PiRuntimeOptions) {}

  private async build(sessionManager: SessionManager, options: OpenSessionOptions): Promise<OpenSessionResult> {
    const { credsDir, piDir } = this.options;
    const allowModelNetwork = this.options.allowModelNetwork !== false;
    // Packaged integration sessions read Pi's own auth/config files. The Bivy
    // credential path remains only for compatibility with explicit legacy use.
    const modelRuntime = this.options.credentialOwner === "agent"
      ? await ModelRuntime.create({
          authPath: path.join(piDir, "auth.json"),
          modelsPath: path.join(piDir, "models.json"),
          allowModelNetwork,
        })
      : await createPiModelRuntime({ credsDir, piDir, allowModelNetwork });
    const backgroundShells = new BackgroundShellTracker();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const sessionId = sessionManager.getSessionId();
      const providedTools = options.toolProvider ? [toolProviderFactory(options.toolProvider)] : [];
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        resourceLoaderOptions: {
          extensionFactories: [guardianFactory(sessionId, options.toolInterceptor), ...providedTools],
        },
      });
      // Override only the built-in bash definition. Pi still owns rendering,
      // truncation and execution; the operations wrapper observes process groups
      // that remain alive after a `command &` shell call returns.
      const bash = createBashToolDefinition(cwd, {
        operations: createBackgroundAwareBashOperations(backgroundShells),
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, customTools: [bash as unknown as ToolDefinition] });
      return { ...result, services, diagnostics: services.diagnostics };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd() || options.workspace,
      agentDir: piDir,
      sessionManager,
    });

    const tui: PiTuiLaunch = {
      credsDir,
      piDir,
      sessionsDir: this.options.sessionsDir,
      piCommand: resolvePiCommand(),
      credentialOwner: this.options.credentialOwner ?? "bivy",
      allowModelNetwork,
    };
    return { session: new PiSession(runtime, tui, backgroundShells), warning: runtime.modelFallbackMessage };
  }

  createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const sessionManager = SessionManager.create(options.workspace, this.options.sessionsDir);
    return this.build(sessionManager, options);
  }

  openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    const sessionManager = SessionManager.open(options.sessionFile, this.options.sessionsDir);
    return this.build(sessionManager, options);
  }

  /**
   * Delete a session's transcript file on a user-initiated delete. pi keeps no
   * in-memory session registry — listSessions reads the store on disk each time —
   * so the whole job is removing the file so SessionManager.listAll stops
   * returning it. Prefer the exact path listAll reports for this id; fall back to
   * a caller-supplied file path (pi's resume ref is itself a path). The node's
   * own inRoot unlink already covers the open-session case; this closes the gap
   * for a session deleted by id alone (e.g. after a restart, when the node holds
   * no live record and never learned the path). Returns true if a file was removed.
   */
  async deleteSession(sessionId: string, sessionFile?: string): Promise<boolean> {
    let file: string | undefined;
    try {
      const match = (await SessionManager.listAll(this.options.sessionsDir)).find((s) => s.id === sessionId);
      file = match?.path;
    } catch {
      // Store unreadable — fall back to the caller-supplied path below.
    }
    if (!file && sessionFile && sessionFile !== sessionId) file = sessionFile;
    if (!file) return false;
    try {
      await fs.promises.unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  /** Pi's provider/model catalog (session-less) — its contribution to the unified picker. */
  async listCatalog(): Promise<CatalogProvider[]> {
    const runtime = this.options.credentialOwner === "agent"
      ? await ModelRuntime.create({
          authPath: path.join(this.options.piDir, "auth.json"),
          modelsPath: path.join(this.options.piDir, "models.json"),
        })
      : await createPiModelRuntime({ credsDir: this.options.credsDir, piDir: this.options.piDir });
    return runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      oauth: isNativeOAuthProvider(provider.id),
      models: runtime.getModels(provider.id).map((model) => toModelInfo(model, true)),
    }));
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await SessionManager.listAll(this.options.sessionsDir);
    return sessions.map((s) => ({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      name: s.name,
      created: s.created,
      modified: s.modified,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    }));
  }

  /**
   * Read a session's transcript from its file without spinning up the runtime.
   * `SessionManager.open` just parses+indexes the JSONL; `buildSessionContext`
   * resolves the message list the same way a live resume does — sdk.js sets
   * `agent.state.messages = buildSessionContext().messages` on resume, so this is
   * the exact shape PiSession.getMessages() would later return. Best-effort: a
   * missing/corrupt file reads as an empty transcript (or undefined if the read
   * itself throws), which the caller treats as "nothing to fast-paint".
   */
  readMessages(sessionFile: string): RuntimeMessage[] | undefined {
    try {
      const sessionManager = SessionManager.open(sessionFile, this.options.sessionsDir);
      return sessionManager.buildSessionContext().messages as unknown as RuntimeMessage[];
    } catch {
      return undefined;
    }
  }

  /**
   * Export a pi session for a same-runtime fork. The payload is just the
   * structured message list a resume would load (`readMessages`) — pi messages
   * round-trip through the session store, so re-appending them on the
   * destination reproduces the conversation exactly. Undefined when the source
   * transcript can't be read.
   */
  exportForFork(sessionFile: string): ForkNativePayload | undefined {
    const messages = this.readMessages(sessionFile);
    if (!messages) return undefined;
    return { runtimeId: this.id, kind: "pi-messages", data: { messages } };
  }

  /**
   * Recreate a pi session from an exported payload: open a fresh session in the
   * destination workspace and replay each message into its store, so the new
   * session resumes with the full transcript. Never touches the source.
   */
  async importForFork(
    payload: ForkNativePayload,
    ctx: ForkImportContext,
  ): Promise<{ sessionFile: string; id: string }> {
    if (payload.runtimeId !== this.id || payload.kind !== "pi-messages") {
      throw new Error(`pi.importForFork: unexpected payload ${payload.runtimeId}/${payload.kind}`);
    }
    const messages = ((payload.data as { messages?: unknown })?.messages ?? []) as RuntimeMessage[];
    const sessionManager = SessionManager.create(ctx.cwd || ctx.workspace, this.options.sessionsDir);
    for (const message of messages) {
      sessionManager.appendMessage(message as unknown as Parameters<typeof sessionManager.appendMessage>[0]);
    }
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("pi.importForFork: session file was not persisted");
    return { sessionFile, id: sessionManager.getSessionId() };
  }

  /**
   * Stand up a pi session from a **cross-runtime** fork's portable history: open
   * a fresh session in the destination workspace and append each `{role, text}`
   * turn as a plain-text message, so the new session resumes on a copy of the
   * whole conversation (fidelity "replayed"). The turns already have any tool
   * activity inlined as text (see buildForkHistory), so nothing here needs to
   * reconstruct provider-specific tool blocks. Never touches the source.
   */
  async importHistoryForFork(
    history: ForkHistoryMessage[],
    ctx: ForkImportContext,
  ): Promise<{ sessionFile: string; id: string }> {
    const cwd = ctx.cwd || ctx.workspace;
    const sessionManager = SessionManager.create(cwd, this.options.sessionsDir);
    const settings = SettingsManager.create(cwd, this.options.piDir);
    const defaultProvider = settings.getDefaultProvider();
    const defaultModel = settings.getDefaultModel();
    const targetModel = ctx.model ?? (defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined);
    const timestamp = Date.now();
    for (const [index, message] of history.entries()) {
      // SessionManager deliberately persists unvalidated objects. A bare
      // `{role, content: string}` looks readable in the UI, but is NOT a valid
      // pi AssistantMessage: the first real prompt later reaches provider and
      // usage code that expects block-array content plus model/usage metadata.
      // That was the codex→pi fork crash ("reading 'length'"). Materialise the
      // portable prose as complete pi-ai messages instead.
      const imported: UserMessage | AssistantMessage = message.role === "user"
        ? {
            role: "user",
            content: [{ type: "text", text: message.text }],
            timestamp: timestamp + index,
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.text }],
            // The target model is enough for pi to restore the requested model
            // before Bivy applies it again after stand-up. The synthetic API id
            // intentionally prevents provider-specific reasoning replay rules;
            // this history contains portable plain text only.
            api: "bivy-fork",
            provider: targetModel?.provider ?? "bivy-fork",
            model: targetModel?.id ?? "portable-history",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: timestamp + index,
          };
      sessionManager.appendMessage(imported);
    }
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("pi.importHistoryForFork: session file was not persisted");
    return { sessionFile, id: sessionManager.getSessionId() };
  }
}
