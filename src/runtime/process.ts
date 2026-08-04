// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { stripAnsi } from "./ansi.js";
import { buildAgentCredentialEnv } from "./credentials.js";
import { egressEnv, sessionEgressEnv } from "../harness/egress.js";
import { depCacheEnv } from "../harness/dep-cache.js";
import { bivySessionEnv } from "./session-env.js";
import type { CliParser, CliParserFactory } from "./cli-parsers.js";
import type { SlashCommandProvider } from "./slash-commands.js";
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
  UsageSnapshot,
} from "./types.js";

/**
 * Model selection for a CLI agent, the general (data-driven) way. A CLI picks its
 * model with a launch flag (`gemini -m <id>`, `aider --model <id>`, …), so the
 * adapter just needs (a) the list of selectable models and (b) how to inject the
 * chosen id into the launch. When `models` is non-empty the ProcessRuntime
 * advertises `modelSelection`, `getModels()` returns the list, `setModel()` picks
 * one, and the choice is spliced into the args for every subsequent prompt.
 */
export interface ProcessModelConfig {
  /** Selectable models surfaced in the picker (id is the CLI's own model name). */
  models: ModelInfo[];
  /** Build the args that select `modelId` (e.g. `id => ["--model", id]`). */
  modelArgs: (modelId: string) => string[];
  /**
   * Where the model args splice into the base launch args: the number of leading
   * base-arg tokens to keep before them. 0 = prepend (correct when the prompt flag
   * is trailing, e.g. gemini's `-p`); 1 = after a leading subcommand (e.g.
   * `opencode run`). Defaults to 0.
   */
  insertAt?: number;
}

/**
 * Reasoning-effort / thinking-level selection for a CLI agent — the same
 * data-driven shape as ProcessModelConfig. A CLI picks reasoning effort with a
 * launch flag (e.g. Codex `-c model_reasoning_effort=<level>`), so the adapter
 * needs the selectable levels and how to inject the chosen one. When set, the
 * session implements the RuntimeSession thinking methods and the daemon's model/
 * thinking picker drives it.
 */
export interface ProcessThinkingConfig {
  /** Selectable levels, e.g. ["minimal","low","medium","high"]. */
  levels: string[];
  /** The initially-effective level (must be in `levels`); defaults to none set. */
  default?: string;
  /** Build the args that select `level` (e.g. `l => ["-c", `model_reasoning_effort=${l}`]`). */
  thinkingArgs: (level: string) => string[];
  /** Splice position in the base launch args (see ProcessModelConfig.insertAt). */
  insertAt?: number;
}

export type ProcessPromptMode = "stdin" | "argv";

export interface ProcessRuntimeOptions {
  id?: string;
  displayName?: string;
  command: string;
  args?: string[];
  promptMode?: ProcessPromptMode;
  env?: Record<string, string>;
  /**
   * Shared credential vault. When set, every model-provider login the node holds
   * (Pi's auth.json) is injected into the agent subprocess as the conventional
   * provider env vars, so one Bivy sign-in serves this agent too.
   */
  credentials?: AgentCredentialStore;
  /**
   * Universal Agent Harness — Phase 4. When set, the agent's stdout is treated as
   * a structured stream (newline-delimited): each line is fed to a fresh
   * CliParser, whose normalized events (streaming assistant text, tool cards, a
   * proper transcript) are emitted instead of the opaque raw-stdout blob. Absent
   * = the original dumb-pipe behavior.
   */
  parserFactory?: CliParserFactory;
  /**
   * Optional credential preflight, run at prompt time against the environment the
   * agent subprocess will inherit (ambient env + the resolved vault handoff).
   * Returns a human-readable error when the agent has no usable credential, so
   * Bivy can surface a clear, actionable message instead of spawning a process
   * that dies with an opaque upstream 401. Returning undefined = proceed.
   */
  preflight?: (
    env: Record<string, string | undefined>,
    ctx: { provider?: string },
  ) => string | undefined;
  /**
   * Optional async preparation, run each prompt after credentials are resolved
   * but before the preflight and spawn. Returns an env patch merged into both —
   * e.g. Codex mints its `auth.json` from Bivy's vault and pins `CODEX_HOME`, so
   * a subscription connected in the app satisfies the preflight and the run.
   * Best-effort: a throw/rejection is swallowed and treated as no patch.
   */
  prepare?: (env: Record<string, string | undefined>) => Promise<Record<string, string> | void> | Record<string, string> | void;
  /**
   * Opt-in resume (off by default — the generic runtime is a fresh process per
   * prompt). When `resumable` is set, `openSession({ sessionFile })` binds a
   * session id and:
   *  - `resumeArgs(id)` replaces the base args for every prompt (e.g.
   *    `codex exec resume <id> --json`), so the agent continues that session;
   *  - `loadHistory(id)` (optional) preloads prior turns from disk so the
   *    reopened chat paints history instead of starting blank.
   * Governance is unchanged — this is structured *resume*, not tool interception.
   */
  resumable?: boolean;
  resumeArgs?: (sessionId: string) => string[];
  loadHistory?: (sessionId: string) => RuntimeMessage[];
  /**
   * Optional store cleanup for a user-initiated delete: remove this session's
   * transcript from the underlying agent's own on-disk store (e.g. Codex's
   * rollout under `$CODEX_HOME`) so deleting it in the app actually sticks. The
   * write-side counterpart to `loadHistory`. Absent = the agent keeps no store
   * Bivy needs to clean (a fresh-process CLI, or one whose history lives under
   * Bivy's own sessions dir). Best-effort; must not throw for a missing file.
   */
  deleteHistory?: (sessionId: string) => void;
  /**
   * Optional model selection (see ProcessModelConfig). Absent = the agent runs on
   * its own default model and the runtime reports modelSelection: false.
   */
  model?: ProcessModelConfig;
  /**
   * Optional reasoning-effort / thinking-level selection (see ProcessThinkingConfig).
   * Absent = the session reports supportsThinking(): false.
   */
  thinking?: ProcessThinkingConfig;
  /**
   * Advertise usage reporting (capabilities.usageReporting). Set when the wired
   * parser extracts token usage from the agent's output; getUsage() then returns
   * that best-effort snapshot (undefined when the turn carried no counts).
   */
  usageReporting?: boolean;
  /**
   * Optional on-disk slash commands (see SlashCommandProvider). When set, the
   * session's getCommands() advertises them (so the composer offers this agent's
   * custom prompts/commands) and prompt() expands a matching `/name args` line
   * into the command's body before running — Codex/opencode custom commands don't
   * expand on the non-interactive path Bivy drives, so Bivy expands them itself.
   * Absent = no agent-native commands (the composer shows the empty state).
   */
  slashCommands?: SlashCommandProvider;
}

/**
 * Send `signal` to `child`'s whole process group when possible, so a forking CLI
 * agent's grandchildren (it shells out to git/npm/build tools, or forks its own
 * worker processes) die with it instead of being orphaned. Relies on the child
 * having been spawned `detached` (making it its own process-group leader, POSIX
 * only — see the spawn() call in ProcessSession.prompt); `process.kill(-pid,
 * signal)` then targets the whole group, mirroring `pty-runner.py`'s
 * `os.killpg`. Falls back to killing just the direct child on Windows (no
 * negative-pid group kill there) or if the group is already gone.
 */
function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such process group (already exited) or we're not its leader — fall
      // through to a direct kill of the child itself.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to a small shell-like splitter
  }
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) out.push(match[1] ?? match[2] ?? match[3] ?? "");
  return out;
}

/**
 * Generic resume primitive for the escape-hatch CLI runtime: `BIVY_AGENT_RESUME_
 * TEMPLATE` (a JSON arg array with an `{id}` placeholder for the agent's own
 * session ref) opts a hand-configured agent into the same data-driven resume path
 * the built-in CLI agents get from `CLI_AGENT_SPECS[id].resume` (see
 * src/runtime/index.ts) — purely as operator config, no code. Absent = a fresh
 * process per prompt, same as any other unconfigured CLI agent.
 */
function genericResumeTemplateFromEnv(): string[] | undefined {
  const raw = process.env.BIVY_AGENT_RESUME_TEMPLATE?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {
    // malformed override — resume stays off
  }
  return undefined;
}

export function processRuntimeFromEnv(): ProcessRuntimeOptions | null {
  const command = process.env.BIVY_AGENT_COMMAND?.trim();
  if (!command) return null;
  const resumeTemplate = genericResumeTemplateFromEnv();
  return {
    id: process.env.BIVY_AGENT_ID?.trim() || "generic-cli",
    displayName: process.env.BIVY_AGENT_NAME?.trim() || "Generic CLI Agent",
    command,
    args: splitArgs(process.env.BIVY_AGENT_ARGS),
    promptMode: process.env.BIVY_AGENT_PROMPT_MODE === "argv" ? "argv" : "stdin",
    ...(resumeTemplate
      ? {
          resumable: true,
          resumeArgs: (sessionId: string) => resumeTemplate.map((a) => a.replace(/\{id\}/g, sessionId)),
        }
      : {}),
  };
}

class ProcessSession implements RuntimeSession {
  /** For a resumed session the id IS the agent's session id (so the daemon's
   *  session ref round-trips); a fresh session gets a random id. */
  readonly id: string;
  private child?: ChildProcessWithoutNullStreams;
  private messages: RuntimeMessage[] = [];
  private emitter = new EventEmitter();
  private streaming = false;
  private name?: string;
  /** Set when this session was opened to resume an existing agent session. */
  private readonly resumeId?: string;

  constructor(private readonly runtimeOptions: ProcessRuntimeOptions, public readonly cwd: string, resumeId?: string) {
    this.resumeId = resumeId;
    this.id = resumeId ?? randomUUID();
    // Preload prior history so a reopened session isn't blank (resumable runtimes).
    if (resumeId && runtimeOptions.loadHistory) {
      try {
        this.messages = runtimeOptions.loadHistory(resumeId);
      } catch {
        this.messages = [];
      }
    }
  }

  /** The resume token handed back to the daemon; the id doubles as the ref. */
  get sessionFile(): string | undefined {
    return this.resumeId;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** PID of the live agent subprocess for the current turn (see RuntimeSession). */
  activePid(): number | undefined {
    return this.child?.pid;
  }

  getMessages(): RuntimeMessage[] {
    return this.messages;
  }

  /** Currently selected model id, or undefined to run on the agent's own default. */
  private currentModelId?: string;
  /** Provider of the selected model — scopes custom base-URL env injection. */
  private currentModelProvider?: string;
  /** Currently selected thinking level, or undefined for the agent's own default. */
  private currentThinkingLevel?: string;
  /** Best-effort usage parsed from the most recent turn (see getUsage). */
  private lastUsage?: UsageSnapshot;

  getModels(): ModelInfo[] {
    return this.runtimeOptions.model?.models ?? [];
  }

  getCurrentModel(): ModelInfo | undefined {
    if (!this.currentModelId) return undefined;
    const known = this.getModels().find((m) => m.id === this.currentModelId);
    // A free-form id (e.g. an operator-supplied model not in the curated list)
    // still round-trips so the picker reflects the actual selection.
    return known ?? { provider: "", id: this.currentModelId, name: this.currentModelId };
  }

  async setModel(provider: string, id: string): Promise<void> {
    if (!this.runtimeOptions.model) throw new Error("Model selection is not supported by this runtime.");
    // Accept any non-empty id (curated or free-form). An empty id clears the
    // selection so the agent falls back to its own default.
    this.currentModelId = id.trim() || undefined;
    this.currentModelProvider = provider?.trim().toLowerCase() || undefined;
  }

  // ---- Thinking / reasoning effort (see ProcessThinkingConfig) --------------
  supportsThinking(): boolean {
    return Boolean(this.runtimeOptions.thinking?.levels.length);
  }

  getAvailableThinkingLevels(): string[] {
    return this.runtimeOptions.thinking?.levels ?? [];
  }

  getThinkingLevel(): string | undefined {
    return this.currentThinkingLevel ?? this.runtimeOptions.thinking?.default;
  }

  setThinkingLevel(level: string): void {
    if (!this.runtimeOptions.thinking) return;
    const next = level.trim();
    // Only accept advertised levels; anything else (incl. "off"/"") clears it so
    // the agent runs on its own default reasoning.
    this.currentThinkingLevel = this.runtimeOptions.thinking.levels.includes(next) ? next : undefined;
  }

  // ---- Usage (see ProcessRuntimeOptions.usageReporting) ---------------------
  async getUsage(): Promise<UsageSnapshot | undefined> {
    return this.lastUsage;
  }

  getName(): string | undefined {
    return this.name;
  }

  setName(name: string): void {
    this.name = name;
  }

  /** The agent's on-disk slash commands for this workspace (Codex prompts,
   *  opencode commands). Best-effort and display-only: any read failure yields an
   *  empty menu, never a throw. */
  getCommands(): AgentCommand[] {
    try {
      return this.runtimeOptions.slashCommands?.list(this.cwd) ?? [];
    } catch {
      return [];
    }
  }

  async suggestName(): Promise<string | undefined> {
    // The generic CLI "dumb-pipe" runtime has no model of its own to name a
    // session with. Returning a raw 60-char truncation of the first message here
    // was actively harmful: it *overrode* the clean first-few-words title (and
    // branch slug) maybeNameSession() derives deterministically, and it's never
    // an agent-written title. Return undefined so that deterministic title stands
    // — and so the node-level LLM namer (server.ts's suggestSessionNameFromNode,
    // which uses whatever model credentials the node holds) can refine it.
    return undefined;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private emit(event: RuntimeEvent) {
    this.emitter.emit("event", event);
  }

  async prompt(text: string, _options?: PromptOptions): Promise<void> {
    if (this.streaming) throw new Error("Agent is already running.");
    const prompt = text.trim();
    if (!prompt) return;

    // A `/name args` line that matches an on-disk command runs the command by
    // sending its expanded body to the agent; the transcript still shows what the
    // user typed. Any non-command line (incl. a leading slash that isn't one)
    // passes through untouched. Best-effort — a read failure sends the raw line.
    let promptToSend: string;
    try {
      promptToSend = this.runtimeOptions.slashCommands?.expand(this.cwd, prompt) ?? prompt;
    } catch {
      promptToSend = prompt;
    }

    this.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    this.streaming = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });

    // A resumed session continues the agent's own session id each turn via
    // resumeArgs (e.g. `codex exec resume <id> --json`); otherwise the base args.
    const baseArgs = this.resumeId && this.runtimeOptions.resumeArgs
      ? this.runtimeOptions.resumeArgs(this.resumeId)
      : (this.runtimeOptions.args ?? []);
    // Selection flags (model + thinking level) splice into the base args at their
    // configured positions — before a trailing prompt flag, or after a leading
    // subcommand. Both `insertAt` values index the ORIGINAL base args, so we apply
    // them highest-index-first: an earlier splice would otherwise shift the indices
    // a later one is relative to. No selection = the agent's own default, untouched.
    const modelConfig = this.runtimeOptions.model;
    const thinkingConfig = this.runtimeOptions.thinking;
    const injections: Array<{ at: number; args: string[] }> = [];
    if (modelConfig && this.currentModelId) injections.push({ at: modelConfig.insertAt ?? 0, args: modelConfig.modelArgs(this.currentModelId) });
    // Only inject an *explicitly chosen* level — an untouched session runs on the
    // agent's own default (which we advertise via getThinkingLevel for display).
    if (thinkingConfig && this.currentThinkingLevel) injections.push({ at: thinkingConfig.insertAt ?? 0, args: thinkingConfig.thinkingArgs(this.currentThinkingLevel) });
    let argsWithFlags = baseArgs;
    for (const { at, args: inject } of injections.sort((a, b) => b.at - a.at)) {
      const idx = Math.min(Math.max(at, 0), argsWithFlags.length);
      argsWithFlags = [...argsWithFlags.slice(0, idx), ...inject, ...argsWithFlags.slice(idx)];
    }
    const args = this.runtimeOptions.promptMode === "argv" ? [...argsWithFlags, promptToSend] : argsWithFlags;
    // Resolve credentials per prompt so freshly-refreshed OAuth tokens (and keys
    // added after this session started) reach the agent. The vault wins over any
    // ambient key so Bivy's shared sign-in is authoritative.
    const credentialEnv = this.runtimeOptions.credentials
      ? await buildAgentCredentialEnv(this.runtimeOptions.credentials, undefined, this.currentModelProvider).catch(() => ({}))
      : {};
    // Optional prepare step (e.g. Codex materializes its auth.json from the vault
    // and pins CODEX_HOME). Runs after credentials, before preflight/spawn; its
    // env patch flows into both. Best-effort — failures never block the run.
    const prepareEnv = this.runtimeOptions.prepare
      ? (await Promise.resolve(this.runtimeOptions.prepare({ ...process.env, ...this.runtimeOptions.env, ...credentialEnv })).catch(() => undefined)) ?? {}
      : {};
    // Credential preflight: if the agent has no usable credential, surface a
    // clear, actionable error instead of spawning a subprocess that dies with an
    // opaque upstream 401 (e.g. Codex's "unexpected status 401 Unauthorized:
    // Missing bearer …" when no OpenAI key/login is present).
    const preflightError = this.runtimeOptions.preflight?.(
      { ...process.env, ...this.runtimeOptions.env, ...credentialEnv, ...prepareEnv },
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
    // The agent enforces its own containment via its native sandbox (Codex
    // --sandbox, Gemini --approval-mode, Claude permissionMode; see
    // src/harness/sandbox.ts). Bivy no longer wraps the process in an OS jail.
    const child = spawn(this.runtimeOptions.command, args, {
      cwd: this.cwd,
      // Route this agent's outbound traffic through an egress proxy: this
      // session's OWN proxy if it has one (a per-session sandbox/workflow network
      // policy — sessionEgressEnv), else the node-global broker when
      // BIVY_EGRESS_PROXY is enabled (else {}). bivySessionEnv() lets the agent's
      // own shell resolve its session for `bivy attach <path>` (see
      // session-env.ts); spread last so it can never be shadowed by an operator-
      // configured env var of the same name.
      env: { ...process.env, ...depCacheEnv(), ...this.runtimeOptions.env, ...credentialEnv, ...prepareEnv, ...(sessionEgressEnv(this.id) ?? egressEnv()), ...bivySessionEnv(this.id) },
      stdio: "pipe",
      // Detached so the child becomes the leader of its own process group
      // (POSIX) — see killProcessGroup() / abort() below, which kill that whole
      // group instead of just this direct child. Without this, a forking CLI
      // agent's grandchildren survive `abort()` as orphans.
      detached: process.platform !== "win32",
    });
    this.child = child;

    let stdout = "";
    let stderr = "";
    let startedMessage = false;

    // Phase 4 — structured mode: feed each complete stdout line to a CliParser
    // and emit its normalized events (streaming text, tool cards, transcript)
    // instead of the raw-stdout blob.
    const parser: CliParser | undefined = this.runtimeOptions.parserFactory?.();
    let lineBuf = "";
    let messagesPushed = false;
    // Emit a batch of parser events; the moment the turn ends (agent_end), sync
    // the parser's transcript into this.messages so getMessages() is correct as
    // soon as agent_end fires — the parser emits agent_end during stdout parsing
    // (on session.done), before the child 'close' handler runs.
    const emitParserEvents = (activeParser: CliParser, events: RuntimeEvent[]) => {
      for (const event of events) this.emit(event);
      if (!messagesPushed && events.some((e) => e.type === "agent_end")) {
        messagesPushed = true;
        for (const message of activeParser.messages()) this.messages.push(message);
        // Capture the turn's best-effort usage so getUsage() is ready by the time
        // the daemon's agent_end handler (refreshSessionUsage) reads it.
        const usage = activeParser.usage?.();
        if (usage) this.lastUsage = usage;
      }
    };
    const feedParser = (activeParser: CliParser, text: string) => {
      lineBuf += text;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        emitParserEvents(activeParser, activeParser.onLine(line));
      }
    };

    const update = () => {
      if (!startedMessage) {
        startedMessage = true;
        this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
      }
      this.emit({ type: "message_update", message: { role: "assistant", content: stripAnsi(stdout) } });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (parser) feedParser(parser, text);
      else update();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      this.emit({ type: "tool_execution_update", toolName: "agent_output", toolCallId: "agent-output", input: { stream: "stderr", output: stripAnsi(stderr.slice(-4000)) } });
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code, signal) => {
      this.child = undefined;
      this.streaming = false;
      if (parser) {
        // Flush any trailing partial line, then let the parser close the turn.
        // The parser owns the full turn lifecycle (message_end/turn_end/
        // agent_end via onClose/session.done), so we don't emit our own here.
        // emitParserEvents pushes the transcript on agent_end; if the parser
        // already finalized mid-stream this close is a no-op for messages.
        if (lineBuf.trim()) emitParserEvents(parser, parser.onLine(lineBuf));
        lineBuf = "";
        emitParserEvents(parser, parser.onClose(code, stderr));
        if (!messagesPushed) for (const message of parser.messages()) this.messages.push(message);
        return;
      }
      const failed = code && code !== 0;
      const content = stripAnsi(stdout.trim() || (failed ? stderr.trim() : ""));
      const cleanStderr = stripAnsi(stderr.trim());
      const message = { role: "assistant", content, ...(failed ? { errorMessage: `Process exited with code ${code}${cleanStderr ? `: ${cleanStderr}` : ""}` } : {}) };
      this.messages.push(message);
      if (!startedMessage) this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
      this.emit({ type: "message_end", message });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", code, signal });
    });

    if (this.runtimeOptions.promptMode !== "argv") {
      child.stdin.end(`${promptToSend}\n`);
    } else {
      // Prompt is already in argv. Still close stdin so agents that also read it
      // (e.g. `codex exec` waits for stdin EOF even with a prompt arg) don't hang
      // forever waiting for input that will never come.
      child.stdin.end();
    }
  }

  async abort(): Promise<void> {
    // Capture the live child now — not inside the timer below — so a fast
    // re-spawn (a new prompt() started after this turn's process has already
    // exited) can never be caught by the delayed SIGKILL: the timer always
    // targets *this* turn's process/group, whatever `this.child` points to by
    // the time it fires.
    const child = this.child;
    if (!child) return;
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), 2000).unref();
  }

  dispose(): void {
    void this.abort();
    this.emitter.removeAllListeners();
  }
}

export class ProcessRuntime implements AgentRuntime {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;

  private sessions: ProcessSession[] = [];

  constructor(private readonly options: ProcessRuntimeOptions) {
    this.id = options.id ?? "generic-cli";
    this.displayName = options.displayName ?? "Generic CLI Agent";
    this.capabilities = {
      toolInterception: false,
      // Model selection only when a model config with a non-empty list is wired
      // (e.g. Gemini/Qwen/Aider/OpenCode); otherwise the agent runs on its own
      // default and the picker must not render a control that no-ops.
      modelSelection: Boolean(options.model?.models.length),
      packages: false,
      // Resume only when the runtime was configured for it (e.g. Codex).
      resume: Boolean(options.resumable),
      fork: false,
      // Usage reporting when a usage-emitting parser is wired (see getUsage).
      usageReporting: Boolean(options.usageReporting),
    };
  }

  /** Session-less catalog contribution: this CLI agent's configured models, grouped by provider. */
  listCatalog(): CatalogProvider[] {
    const byProvider = new Map<string, CatalogProvider>();
    for (const model of this.options.model?.models ?? []) {
      const id = model.provider?.trim().toLowerCase();
      if (!id) continue;
      let entry = byProvider.get(id);
      if (!entry) {
        entry = { id, name: id, models: [] };
        byProvider.set(id, entry);
      }
      entry.models.push(model);
    }
    return [...byProvider.values()];
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new ProcessSession(this.options, options.workspace);
    this.sessions.push(session);
    return { session, warning: "Generic CLI runtime streams stdout/stderr only; approvals, model picker, and resume depend on the underlying agent protocol." };
  }

  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    // Resumable runtimes bind the agent's session id so each prompt continues it
    // (see resumeArgs); non-resumable ones ignore the ref and start fresh.
    if (this.options.resumable) {
      const session = new ProcessSession(this.options, options.workspace, options.sessionFile);
      this.sessions.push(session);
      return { session };
    }
    return this.createSession(options);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.map((session) => ({
      id: session.id,
      cwd: session.cwd,
      name: session.getName(),
      messageCount: session.getMessages().length,
    }));
  }

  /**
   * Forget a session on a user-initiated delete. Drops the in-memory handle so
   * listSessions (which reports the runtime's live sessions) stops returning it,
   * and — for resume-capable agents that persist transcripts in their own store
   * (Codex) — removes that on-disk rollout via `deleteHistory` so it can't be
   * re-surfaced. Returns true if anything was removed.
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
      try {
        this.options.deleteHistory(sessionId);
        removed = true;
      } catch {
        // Best-effort store cleanup — a missing/locked rollout must not fail the delete.
      }
    }
    return removed;
  }
}
