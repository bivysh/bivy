// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Runtime-agnostic agent interface.
//
// This is the seam that lets Bivy drive *any* agent runtime, not
// just Pi. Everything the daemon, guardian, relay and UI need from "the agent"
// is expressed here in terms that contain no Pi types. A concrete runtime
// (Pi today; Claude Agent SDK, a generic RPC agent, etc. later) lives behind an
// `AgentRuntime` implementation that maps these calls onto its own SDK.
//
// The shapes below are deliberately a *subset* of what Pi exposes — exactly the
// surface `src/server.ts` consumes — so the first adapter is a thin wrapper and
// the contract is small enough for other runtimes to satisfy.
//
// Nothing imports this yet; it is the target interface for the migration
// described in docs/pluggable-runtime.md.

/**
 * Normalized streaming event. The named types are the ones the daemon switches
 * on today (busy/idle tracking); any other string is forwarded verbatim so
 * runtime-specific events still reach the UI for debugging.
 */
export type RuntimeEventType =
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_update"
  | "turn_end"
  | "tool_call"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "tool_result"
  | "agent_end"
  | (string & {});

export interface RuntimeEvent {
  type: RuntimeEventType;
  [key: string]: unknown;
}

/** Opaque conversation message. The UI renders it; the daemon never inspects it. */
export type RuntimeMessage = Record<string, unknown>;

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * How a prompt sent while the session is already streaming should be handled:
 * `"steer"` injects it into the current turn immediately; `"followUp"` defers
 * it until the current turn ends. Not every runtime honors both — see
 * RuntimeCapabilities.streamingBehaviors.
 */
export type StreamingBehavior = "steer" | "followUp";

export interface PromptOptions {
  streamingBehavior?: StreamingBehavior;
  images?: PromptImage[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: unknown;
  /** Current effective thinking/reasoning level for this session (when supported) */
  thinkingLevel?: string;
  /** Available thinking levels for this model (when supports reasoning) */
  availableThinkingLevels?: string[];
  /**
   * Whether this model's provider currently has auth configured on this node.
   * Only meaningful on entries returned by getAllModels() — getModels() only
   * ever returns configured models, so it's always true (or omitted) there.
   * Optional; absent is treated as configured (back-compat with runtimes that
   * only ever return connected models, e.g. Claude Code SDK).
   */
  configured?: boolean;
}

/**
 * Context handed to a tool interceptor before a tool runs. This is the single
 * most important cross-runtime primitive: it is what the guardian/approval
 * layer (the product's defensible governance feature) hooks into.
 */
export interface ToolCallContext {
  sessionId: string;
  toolName: string;
  input: unknown;
  /** Abort signal for the in-flight tool call/turn, when the runtime can supply
   *  one. Lets an interceptor that blocks-and-waits (e.g. the AskUserQuestion
   *  question card) settle immediately when the user aborts, instead of parking
   *  the turn until its own timeout. Optional; absent = no abort plumbing. */
  signal?: AbortSignal;
}

/**
 * An interceptor's verdict on a tool call. Three outcomes:
 *  - return nothing (or an empty object) → allow: run the tool normally.
 *  - `{ block: true, reason }` → deny: the tool does not run and `reason` is
 *    returned to the agent as an error tool result.
 *  - `{ handled: true, result }` → Bivy serviced this call itself: the tool does
 *    not run and `result` is returned to the agent as the tool result. Distinct
 *    from block so an answered AskUserQuestion isn't recorded/surfaced as a
 *    denial. A general primitive — any tool Bivy wants to answer for the agent.
 */
export interface ToolCallDecision {
  block?: boolean;
  reason?: string;
  handled?: boolean;
  result?: string;
}

export type ToolInterceptor = (
  ctx: ToolCallContext,
) => Promise<ToolCallDecision | void> | ToolCallDecision | void;

/**
 * A single node-hosted tool offered to a session's agent. Fully serializable so
 * it can cross the daemon↔service RPC link; the executing closure (and any
 * credentials/HTTP clients it needs) stays on the daemon behind
 * ToolProvider.invoke. Deliberately agent-agnostic — no field is specific to any
 * agent SDK.
 */
export interface ToolSpec {
  name: string;
  label?: string;
  description?: string;
  /** Short text describing the tool, injected into the agent's system prompt. */
  promptSnippet?: string;
  /** JSON-Schema object describing the tool's parameters. */
  parameters: unknown;
}

/** One block of a tool result (text today; other media can extend `type`). */
export interface ToolResultContent {
  type: string;
  text?: string;
}

/** The serializable result of executing a provided tool. */
export interface ToolResult {
  content?: ToolResultContent[];
  isError?: boolean;
  /** Opaque structured detail a runtime may surface; not interpreted by Bivy. */
  details?: unknown;
}

/**
 * A set of node-hosted tools offered to a session, plus the means to run them.
 * The RUNTIME-AGNOSTIC sibling of ToolInterceptor: the daemon owns the tools'
 * implementation (Bivy integrations today, MCP later), and a runtime adapter that
 * supports extra tools registers each ToolSpec into its agent and routes calls
 * back to invoke(). An adapter that doesn't simply ignores it. Because the seam
 * is agnostic, nothing on the RPC link depends on any specific agent — a remote
 * runtime forwards invoke() over reverse RPC, keeping the executing closures and
 * credentials on the daemon exactly like the guardian.
 */
export interface ToolProvider {
  /** The tools to register into the agent at session start. */
  list(): ToolSpec[];
  /** Execute a provided tool by name and return its result. */
  invoke(toolName: string, toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

/** Lightweight session listing (maps to Pi's SessionManager.listAll). */
export interface SessionSummary {
  id: string;
  path?: string;
  cwd?: string;
  name?: string;
  created?: unknown;
  modified?: unknown;
  messageCount?: number;
  firstMessage?: string;
}

/**
 * Bounded metadata for a provider-native session Bivy did not start — e.g. a
 * bare `claude` or `codex` run outside Bivy (see issue #156, "discover and
 * adopt existing provider-native sessions"). Deliberately NOT a transcript: no
 * message content ever rides this shape, so it's safe to list in the UI and
 * (if a node ever advertises discoveries upstream) safe to hand to the control
 * plane. Produced by `AgentRuntime.discoverNativeSessions` and consumed by the
 * discovery/import flow in src/runtime/native-session-discovery.ts.
 */
export interface DiscoveredNativeSession {
  /** The producing runtime's id (e.g. "claude-code-sdk", "codex-approvals"). */
  runtimeId: string;
  /** The provider's own session id/ref — the exact token `openSession` resumes by. */
  ref: string;
  /** Absolute path of the on-disk transcript backing this session, when known
   *  (used only for same-conversation dedupe; never read for its content here). */
  file?: string;
  /** Working directory the session ran in, when the provider recorded one. */
  cwd?: string;
  /** Epoch ms the session was last updated (mtime or a recorded timestamp). */
  updatedAt?: number;
  /** First user prompt, truncated — a readable list label. Never the full transcript. */
  title?: string;
  /** True when a live external process for this session was detected (best-effort). */
  active: boolean;
  /** True when the provider can resume this exact session with native context. */
  resumable: boolean;
}

/** A live agent session, runtime-agnostic. */
export interface RuntimeSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionFile?: string;

  /** Whether the agent is currently producing output. */
  readonly isStreaming: boolean;

  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;

  /** Release runtime resources (called on shutdown). */
  dispose(): void;

  /**
   * PID of the agent's live OS subprocess for the current turn, or undefined
   * when nothing is running (agents spawn per-turn and exit) or when the runtime
   * has no separable process (Pi runs in-process; Claude Code's process lives
   * inside the SDK). Best-effort — used only for the "Node stats" panel's
   * per-session resource attribution, never for control.
   */
  activePid?(): number | undefined;

  /** Current persisted conversation history. */
  getMessages(): RuntimeMessage[];

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;

  // ---- Models (optional capability: AgentRuntime.capabilities.modelSelection)
  // May be async: resolving which providers are available can require reading
  // the credential store (e.g. the Pi runtime surfaces a mid-session login).
  getModels(): ModelInfo[] | Promise<ModelInfo[]>;
  getCurrentModel(): ModelInfo | undefined;
  setModel(provider: string, id: string): Promise<void>;

  /**
   * Every model the runtime knows how to run — including providers with no
   * auth configured yet — so the model picker can offer them with an inline
   * "connect" action (model picker's "other models" section, #390). Each
   * entry's `configured` flag reflects whether its provider currently has
   * auth on this node. Optional: a runtime that doesn't distinguish "all" from
   * "available" (e.g. single-provider Claude Code) can leave this undefined,
   * and the picker just shows getModels() with no "other models" section.
   */
  getAllModels?(): ModelInfo[] | Promise<ModelInfo[]>;

  // ---- Thinking / reasoning levels (optional capability for models that support it)
  getThinkingLevel?(): string | undefined;
  setThinkingLevel?(level: string): void;
  getAvailableThinkingLevels?(): string[];
  supportsThinking?(): boolean;

  // ---- Naming
  getName(): string | undefined;
  setName(name: string): void;
  /** Ask the runtime to propose a short title for a first prompt. */
  suggestName(firstPrompt: string): Promise<string | undefined>;

  /**
   * Describe how to resume this exact session in the runtime's own interactive
   * TUI on this node, or null if unsupported/unavailable. Only meaningful when
   * the runtime advertises capabilities.interactiveTui. The daemon launches this
   * in a PTY (see the terminal) as a chat↔TUI hand-off.
   */
  interactiveTuiCommand?(): Promise<TuiLaunchSpec | null> | TuiLaunchSpec | null;

  /**
   * Best-effort cost/token/plan-quota snapshot (optional capability:
   * AgentRuntime.capabilities.usageReporting). Display-only — never used for
   * enforcement. Returns undefined if the runtime can't report it right now.
   */
  getUsage?(): Promise<UsageSnapshot | undefined>;

  /**
   * Enumerate the agent's own slash commands for this session — extension
   * commands, prompt templates, skills, etc. — so the composer can offer them
   * in autocomplete (surfaced via capabilities.commands, see AgentCommand).
   * These are invoked per each command's `mode`: "prompt" (the default) sends
   * the raw "/name args" text as a prompt, so a runtime whose prompt() interprets
   * a leading slash (Pi and Claude do) runs the command instead of sending it to
   * the model; "protocol" routes through invokeCommand() instead. The set is
   * dynamic (it depends on the session's workspace/extensions), so this is read
   * per session rather than declared statically on RuntimeCapabilities.
   * Optional; absent = none.
   */
  getCommands?(): AgentCommand[];

  /**
   * Invoke an advertised agent command whose `mode` is "protocol" — i.e. one the
   * runtime handles out-of-band rather than by re-parsing a slash prompt. `name`
   * is the canonical "/name"; `args` is the (possibly empty) remainder. Only
   * runtimes that advertise a protocol-mode command need implement this; the
   * daemon never calls it for "prompt"-mode commands (those go through prompt()).
   * Optional; absent = the runtime advertises no protocol-mode commands.
   */
  invokeCommand?(name: string, args: string): Promise<void>;
}

/** One rate-limit window from a metered subscription plan (e.g. Claude Pro/Max). */
export interface UsageWindow {
  /** e.g. "5-hour", "7-day", "7-day (Opus)". */
  label: string;
  /** 0-100, or null if the runtime didn't report a number. */
  utilizationPct: number | null;
  /** ISO 8601 timestamp the window resets, or null if unknown. */
  resetsAt: string | null;
}

export interface UsageSnapshot {
  costUsd?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  /**
   * Remaining quota on a metered OAuth/subscription plan (e.g. Claude Pro/Max),
   * as opposed to a pay-per-token API key — undefined when the runtime has no
   * such concept or the session isn't authenticated that way.
   */
  plan?: {
    subscriptionType?: string | null;
    windows?: UsageWindow[];
  };
}

export interface OpenSessionOptions {
  workspace: string;
  /** Existing session file to resume; omit to create a fresh session. */
  sessionFile?: string;
  /**
   * Interceptor consulted before each tool call. The runtime must call it and
   * honor a `block` decision; runtimes without tool interception cannot back
   * the governance tier (see capabilities.toolInterception).
   */
  toolInterceptor?: ToolInterceptor;
  /**
   * Extra node-hosted tools to offer this session (Bivy integrations today; MCP
   * later). Runtime-agnostic sibling of toolInterceptor — an adapter that
   * supports extra tools registers each ToolSpec and routes calls to invoke();
   * one that doesn't ignores it. The executing closures never leave the daemon,
   * so a remote runtime forwards invoke() over reverse RPC.
   */
  toolProvider?: ToolProvider;
}

export interface OpenSessionResult {
  session: RuntimeSession;
  /** Non-fatal note, e.g. requested model unavailable so a fallback was used. */
  warning?: string;
}

/**
 * Declares which optional features a runtime supports so the daemon can degrade
 * gracefully and the UI can hide unsupported actions.
 */
export interface RuntimeCapabilities {
  /** Can intercept tool calls — required for the approval/governance tier. */
  toolInterception: boolean;
  /**
   * The agent's MCP tool calls are gated by the same Approve/Deny flow as native
   * tool interception, via the `bivy mcp-proxy` shim (see src/harness/mcp-*.ts):
   * at session start Bivy rewrites the agent's MCP config so each stdio server
   * launches through the proxy, which asks the daemon (`/api/mcp/decide` →
   * guardianInterceptor) before every `tools/call`. This is NARROWER than
   * `toolInterception` — it governs only tools the agent invokes *through MCP*, not
   * its built-in shell/file edits — so it's a distinct, honest capability rather
   * than a claim of full per-tool approval. On only when `BIVY_MCP_PROXY` is
   * enabled for a ProcessRuntime CLI agent (Pi/Claude-SDK govern MCP natively).
   * Optional; absent/false = MCP calls run under effect-level governance only.
   */
  mcpToolApprovals?: boolean;
  /** Exposes a model registry the user can pick from. */
  modelSelection: boolean;
  /** Can install/list/update packages or extensions. */
  packages: boolean;
  /** Supports resuming a persisted session from a file. */
  resume: boolean;
  /**
   * True when the runtime's resume token (RuntimeSession.sessionFile /
   * SessionSummary.path) is a filesystem path to a transcript the daemon can
   * open directly — Pi. The daemon confines such refs to its sessions directory
   * as a path-traversal guard. Absent/false means the ref is an opaque session
   * id the runtime resolves itself (e.g. Claude Code resumes by session UUID,
   * storing its transcript under ~/.claude), so the sessions-dir guard must not
   * apply — doing so is what made those sessions un-resumable. Optional; absent = false.
   */
  sessionRefIsPath?: boolean;
  /** Supports forking a session. */
  fork: boolean;
  /**
   * The runtime can EXPORT a session's transcript and IMPORT it back into a fresh
   * session on another node, so a **same-runtime** fork (see
   * docs/session-fork-plan.md) is full fidelity rather than seeded. Backed by
   * `AgentRuntime.exportForFork` / `importForFork`. Absent/false means a fork
   * that targets this runtime always falls back to a seeded continuation prompt.
   * Optional; absent = false.
   */
  forkTransport?: boolean;
  /**
   * The runtime can hand a live session to its own interactive CLI/TUI on this
   * node (see RuntimeSession.interactiveTuiCommand). Optional; absent = false.
   */
  interactiveTui?: boolean;
  /** Can report cost/token/plan-quota usage (see RuntimeSession.getUsage). Optional; absent = false. */
  usageReporting?: boolean;
  /**
   * The runtime can discover a prior on-disk session for a workspace by cwd +
   * start-time (see the daemon's SESSION_DISCOVERY_BY_AGENT), so a `bivy run`
   * terminal with no pinned sessionId can still be continued as a governed chat.
   * Drives the PWA's "continue as chat" affordance for takeover terminals.
   * Optional; absent = false.
   */
  sessionDiscovery?: boolean;
  /**
   * Agent-native slash commands the agent exposes (see AgentCommand). The chat
   * composer merges the *active session's* set into its autocomplete so a user on
   * the PWA can invoke the same slashes they'd type in the agent's TUI. These are
   * session-specific (they depend on the workspace/extensions), so they are
   * advertised per session (session.created / session.capabilities) rather than
   * mutated onto a shared runtime row; a runtime may still seed a static,
   * session-independent set here for the pre-session draft composer. Optional;
   * absent/empty = none advertised.
   */
  commands?: AgentCommand[];
  /**
   * Which streamingBehavior hints (see PromptOptions.streamingBehavior) this
   * runtime actually honors when prompted mid-turn, so the client (issue #154's
   * queued-follow-ups UI) knows whether an explicit "Steer current turn"
   * action is safe to offer at all. Absent/empty means the client should never
   * attempt a mid-turn prompt for this runtime — hold everything in its own
   * queue and only ever send into an idle session. Advertised statically here
   * for a built-in runtime (Pi, Claude Code); a protocol/RPC shim can instead
   * declare it in its `hello` (see capabilitiesFromHello in
   * src/runtime/protocol.ts), which defaults to none when omitted — an
   * arbitrary shim must opt in before the client will ever try to interrupt it.
   */
  streamingBehaviors?: StreamingBehavior[];
  /**
   * The runtime can enumerate its own provider-native sessions that exist on
   * this node's filesystem but that Bivy did not start (see issue #156) —
   * backed by `AgentRuntime.discoverNativeSessions`. Discovery returns only
   * bounded metadata (DiscoveredNativeSession), never transcript content.
   * Optional; absent/false = the UI must not show a discovery affordance for
   * this runtime (an unsupported provider must never show a misleading action).
   */
  nativeSessionDiscovery?: boolean;
  /**
   * The runtime can adopt/import one of its own discovered native sessions
   * (capabilities.nativeSessionDiscovery) into a Bivy-managed session — via the
   * ordinary `openSession`/resume path — without rewriting or deleting the
   * provider's original history. When the discovered session is resumable this
   * is a native resume; when it isn't, adoption falls back to a seeded
   * continuation and the caller must disclose that to the user before
   * importing (see native-session-discovery.ts's planNativeAdoption). Optional;
   * absent/false = discovered sessions (if any) are informational only, with no
   * import action offered.
   */
  nativeSessionAdoption?: boolean;
}

/**
 * An agent-native slash command the runtime advertises so the chat composer can
 * offer it in autocomplete (e.g. Claude Code's `/compact`, a shim's `/status`).
 * Invocation depends on `mode`: "prompt" (the default) forwards the raw
 * "/name args" line as a normal prompt and the agent/shim interprets it (Pi and
 * Claude Code work this way); "protocol" routes through
 * RuntimeSession.invokeCommand() and a dedicated `command.invoke` message.
 */
export interface AgentCommand {
  /** Canonical command including the leading slash, e.g. "/compact". */
  name: string;
  /** One-line description shown in the composer's command menu. */
  description?: string;
  /**
   * How the client invokes the command. Absent/"prompt" (the default) sends the
   * raw slash line as a prompt; "protocol" issues a `command.invoke` message the
   * shim answers. Only advertise "protocol" when there is real transport behind
   * it (RuntimeSession.invokeCommand) — never flip it without a handler.
   */
  mode?: "prompt" | "protocol";
}

/** One option the user can pick for a UserQuestionItem. */
export interface UserQuestionOption {
  label: string;
  description?: string;
  /** Optional preview content (markdown/HTML per the runtime) for this option. */
  preview?: string;
}

/** One clarifying question within a `user_question` event's `questions` array. */
export interface UserQuestionItem {
  question: string;
  /** Short chip/tag label, e.g. "Auth method". */
  header: string;
  options: UserQuestionOption[];
  /** Allow selecting more than one option for this question. */
  multiSelect?: boolean;
}

/** The host's answer to a pending `user_question`, keyed by each item's `question` text. */
export type UserQuestionAnswer = { behavior: "completed"; answers: Record<string, string> } | { behavior: "cancelled" };

/** How to launch a session in the runtime's interactive TUI (resuming it). */
export interface TuiLaunchSpec {
  command: string;
  args: string[];
  /** Extra env merged over the terminal's environment (e.g. resolved creds). */
  env?: Record<string, string>;
}

/** A pluggable agent backend. One implementation per runtime. */
export interface AgentRuntime {
  /** Stable identifier, e.g. "pi", "claude-agent-sdk". */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;

  createSession(options: OpenSessionOptions): Promise<OpenSessionResult>;
  openSession(
    options: OpenSessionOptions & { sessionFile: string },
  ): Promise<OpenSessionResult>;
  listSessions(): Promise<SessionSummary[]>;
  /**
   * Read a persisted session's transcript straight from disk, WITHOUT building
   * the (expensive) live runtime. This is the fast path behind opening a session
   * in the PWA: constructing the agent runtime — model registry, auth, resource
   * loaders, extensions — can take many seconds, during which the transcript is
   * already sitting in the session file. Runtimes whose resume replays history on
   * the next turn rather than preloading it (e.g. Claude Code) can't answer this
   * and should leave it undefined; the caller then falls back to a full open.
   * Returns the same message shape as a resumed session's getMessages().
   * Optional; absent = no fast path.
   */
  readMessages?(sessionFile: string): RuntimeMessage[] | undefined;

  /**
   * Export a session's transcript as an opaque, runtime-owned payload so a
   * **same-runtime** fork can be reconstructed with full fidelity on another
   * node (see docs/session-fork-plan.md). The payload is understood only by this
   * runtime's `importForFork`; the fork engine treats it as a black box and, for
   * a cross-runtime fork, ignores it in favour of a seeded prompt. `sessionFile`
   * is the resume ref the node holds (a path for pi, a session id for Claude
   * Code). Returns undefined when there is nothing to export. Only meaningful
   * when `capabilities.forkTransport` is true. Optional; absent = seeded only.
   */
  exportForFork?(sessionFile: string): ForkNativePayload | undefined;

  /**
   * Import a payload previously produced by THIS runtime's `exportForFork` into a
   * brand-new session on this node, returning the resume ref + id of the created
   * session. The fork engine only calls this when `payload.runtimeId === this.id`.
   * Must not mutate the source session. Only meaningful when
   * `capabilities.forkTransport` is true. Optional; absent = seeded only.
   */
  importForFork?(
    payload: ForkNativePayload,
    ctx: { workspace: string; cwd: string },
  ): Promise<{ sessionFile: string; id: string }>;

  /**
   * Remove a persisted session from this runtime's OWN on-disk store so a
   * user-initiated delete actually sticks. The node's deleteSessionFile clears
   * Bivy's metadata row and the transcript under `piDir/sessions`, but a runtime
   * that keeps its transcripts elsewhere (Claude Code's BIVY_CLAUDE_SESSIONS_DIR
   * / `~/.claude/projects`, Codex's CODEX_HOME) would otherwise re-surface the
   * session on the very next `listSessions()` — only the owning runtime knows
   * where its store lives. `sessionFile` is the resume token / path the node
   * holds (may be absent). Returns true if it removed something. Optional; absent
   * = the runtime keeps no store of its own (its transcripts already live under
   * Bivy's sessionsDir, which deleteSessionFile unlinks directly).
   */
  deleteSession?(sessionId: string, sessionFile?: string): Promise<boolean>;

  /**
   * Enumerate this runtime's own provider-native sessions on this node that
   * Bivy did not start (see issue #156 and capabilities.nativeSessionDiscovery).
   * Must return only bounded metadata — never transcript content — and must
   * confine its search to this provider's own known store(s) (e.g. Claude's
   * `~/.claude`/`CLAUDE_CONFIG_DIR`, Codex's `~/.codex`/`CODEX_HOME`), honoring
   * a non-default home/config dir when the provider is configured to use one.
   * Best-effort: a missing/unreadable store returns an empty list, never throws.
   * Only meaningful when capabilities.nativeSessionDiscovery is true. Optional;
   * absent = the runtime advertises no native sessions to discover.
   */
  discoverNativeSessions?(): Promise<DiscoveredNativeSession[]> | DiscoveredNativeSession[];

  /**
   * The providers + models this agent supports, WITHOUT starting a session — so
   * Bivy can aggregate a unified model catalog across every installed agent
   * (pi is just one contributor). Optional; absent = this agent contributes no
   * catalog (its models are only known per-session via getModels()).
   */
  listCatalog?(): Promise<CatalogProvider[]> | CatalogProvider[];
}

/**
 * An opaque, runtime-owned transcript export for a same-runtime session fork.
 * Produced by `AgentRuntime.exportForFork` and consumed only by the same
 * runtime's `importForFork` — the fork engine never inspects `data`.
 */
export interface ForkNativePayload {
  /** The producing runtime's id; the engine imports only into a matching runtime. */
  runtimeId: string;
  /** Runtime-scoped discriminator for the payload shape (e.g. "pi-messages"). */
  kind: string;
  /** Opaque payload; must be JSON-serialisable so it can ride the E2E bundle. */
  data: unknown;
}

/** A provider and the models an agent can run under it — one session-less catalog entry. */
export interface CatalogProvider {
  id: string;
  name: string;
  /** Supports subscription/OAuth login. */
  oauth?: boolean;
  models: ModelInfo[];
}

/**
 * A model-provider credential the node already holds, exposed runtime-agnostically.
 * This is the seam that lets any agent reuse a login the user did once (resolved
 * from Bivy's own credential store) instead of authenticating separately per agent.
 */
export interface ProviderCredential {
  /** Provider id the credential is for, e.g. "anthropic", "openai". */
  provider: string;
  /** Whether the token is a plain API key or an OAuth bearer (auto-refreshed). */
  kind: "api_key" | "oauth";
  /** A ready-to-use API key or OAuth access token for the provider. */
  token: string;
  /** Extra provider-scoped env (e.g. a custom base URL) to pass through. */
  env?: Record<string, string>;
}

/**
 * Node-level credential resolver shared across agents. Backed by Bivy's own
 * credential store (credential-store.ts); an adapter resolves a provider's
 * credential and maps it to whatever an agent's SDK expects (env var, header, …)
 * so one login serves every runtime.
 *
 * Named `AgentCredentialStore` to disambiguate from pi-ai's own `CredentialStore`
 * (the storage interface Bivy's store implements for injection into Pi).
 */
export interface AgentCredentialStore {
  /** Resolve a usable credential for a provider, or undefined if none is configured. */
  getCredential(provider: string): Promise<ProviderCredential | undefined>;
  /** Provider ids the vault currently holds a credential for (for bulk env injection). */
  listConfigured?(): Promise<string[]>;
}
