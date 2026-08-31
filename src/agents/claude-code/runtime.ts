// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Claude Code integration bridge. The SDK is transport glue around the
// operator-installed `claude` executable; Bivy does not substitute its bundled
// fallback agent. This module is isolated from core under src/agents.
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
  AttachToChatFn,
  CatalogProvider,
  DiscoveredNativeSession,
  ForkHistoryMessage,
  ForkImportContext,
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
  ToolProvider,
  TuiLaunchSpec,
  UsageSnapshot,
  UsageWindow,
} from "../../runtime/types.js";
import { withExactCapabilitySurface } from "../../runtime/types.js";
import { mapToolCall, mapToolResult } from "../../runtime/tool-call-map.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { depCacheEnv } from "../../harness/dep-cache.js";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { sandboxTier, claudePermissionModeFor, type SandboxTier } from "../../harness/sandbox.js";
import { autoAttachToolImagesEnabled, PassiveImageBudget } from "../../harness/tool-image-attachments.js";
import { anthropicCredentialPreflight, describeAnthropicError, isAnthropicAuthError } from "../../runtime/anthropic-preflight.js";
import { toModelInfo as sharedToModelInfo } from "../../runtime/normalize.js";
import { hasLiveProcessForCwd } from "../../runtime/native-process-scan.js";
import { bivySessionEnv } from "../../runtime/session-env.js";

/** Binary names a live Claude Code process could be running under (see
 *  native-process-scan.ts's best-effort cwd match). */
const CLAUDE_BIN_NAMES = ["claude"];

const CLAUDE_CLI_PATH_CACHE = new Map<string, string | undefined>();

/** Resolve the operator-installed Claude Code CLI; never use the SDK's bundled fallback. */
export function claudeCliPath(): string | undefined {
  const command = process.env.BIVY_CLAUDE_COMMAND?.trim() || "claude";
  const key = `${command}\0${process.env.PATH ?? ""}`;
  if (CLAUDE_CLI_PATH_CACHE.has(key)) return CLAUDE_CLI_PATH_CACHE.get(key);
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    encoding: "utf8",
  });
  const resolved = result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
  CLAUDE_CLI_PATH_CACHE.set(key, resolved);
  return resolved;
}

export function invalidateClaudeCliProbe(): void {
  CLAUDE_CLI_PATH_CACHE.clear();
}

export function claudeCliAvailable(): boolean {
  return Boolean(claudeCliPath());
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
// Placeholder catalog shown before a live agent can answer (see getModels() and
// warmModels()). A not-yet-started session has no subprocess to query, so the
// picker shows this until warmModels() spawns one and supportedModels() replaces
// it with the account's real, current lineup. Keep it roughly current so the
// pre-warm placeholder isn't jarringly stale, but it is only a placeholder — the
// live list is the source of truth.
const FALLBACK_MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", reasoning: true },
  { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", reasoning: true },
];

// The SDK's supportedModels() labels each row with a bare family+version
// ("Opus 4.8") or a family alias ("Sonnet", "Haiku") — while a not-yet-started
// session's picker uses FALLBACK_MODELS' product names ("Claude Opus 4.8"). That
// left a running session's picker showing a differently-named catalog than a
// fresh one. Brand the live rows to match by prefixing "Claude " to any known
// family label, so the catalog reads the same before and after a session starts.
// The family list is data — a new lineup means adding a row here, not an `if` —
// and branding derives from the SDK's own labels so the list never goes stale.
const CLAUDE_MODEL_FAMILIES = ["Opus", "Sonnet", "Haiku", "Fable", "Mythos"];
function brandClaudeModel(model: ModelInfo): ModelInfo {
  if (model.name.startsWith("Claude ")) return model;
  const family = CLAUDE_MODEL_FAMILIES.find((f) => model.name === f || model.name.startsWith(`${f} `));
  return family ? { ...model, name: `Claude ${model.name}` } : model;
}

export interface ClaudeCodeRuntimeOptions {
  /** Default model alias/id passed to the SDK (e.g. "claude-opus-4-8"). */
  defaultModel?: string;
  /** Directory the SDK looks in to list/resume persisted sessions. */
  sessionsDir?: string;
  /** Operator-installed Claude Code executable used by the SDK bridge. */
  executablePath?: string;
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
  /**
   * Backs the native `attach_to_chat` tool (issue #291) — registered as an
   * in-process MCP server (via the SDK's createSdkMcpServer/tool) so the agent
   * sees it in its tool list instead of having to shell out to `bivy attach`.
   * Absent = the tool isn't registered and the session falls back to the
   * discoverability prompt hint alone (BIVY_ATTACH_SYSTEM_PROMPT).
   */
  attachToChat?: AttachToChatFn;
  /** Override for the SDK loader (tests inject a fake `query()`); defaults to
   *  importing the real optional SDK package. */
  sdkLoader?: () => Promise<any>;
}

/**
 * Appended to the Claude Code system prompt so the agent DISCOVERS the outbound
 * attachment capability. `bivy attach` is just a shell command — without this the
 * agent has no way to know it exists and, when asked to "send a file", concludes
 * it can't (it looks for a tool, finds none). BIVY_SESSION_ID is injected into the
 * subprocess env (see spawnQuery), so the bare command resolves the session. Keep
 * this short: it rides on every turn's system prompt.
 *
 * The chat still has no route to a LOCAL/workspace file path, so that half of the
 * guidance (use `bivy attach`, not markdown, for those) stands. A REMOTE
 * `https://` image URL is different: the node now fetches it server-side and
 * serves it back to the chat (see src/session/inline-image-fetch.ts, issue #293),
 * so plain markdown is the right tool there — `bivy attach` only works on files
 * already inside the workspace, which a URL by definition isn't.
 */
export const BIVY_ATTACH_SYSTEM_PROMPT =
  "Sending files and images to the user: the person you're talking to is in a chat UI. They cannot see files you only " +
  "write to disk, and the chat has no route to a workspace file path. " +
  "To show them a LOCAL file or image — a report, screenshot, chart, or a file they asked for — run " +
  '`bivy attach <path> [--caption "short note"]` in your shell. ' +
  "An image renders inline in the chat; any other file shows as a downloadable chip. The path must be inside the session " +
  "workspace. Do NOT use markdown image syntax like ![](path) for a local file or workspace path — it will not render; " +
  "always use `bivy attach` for those. A REMOTE image you already have a URL for is different: plain markdown " +
  "`![alt](https://...)` renders it inline, no attach needed. Prefer `bivy attach` / markdown links over pasting large " +
  "file contents or describing where a file lives on disk.";

/** Name of the in-process MCP server the native attach tool is registered
 *  under (see buildAttachMcpServer) — the SDK namespaces the tool the agent
 *  sees as `mcp__<server>__<tool>`. */
export const BIVY_ATTACH_MCP_SERVER_NAME = "bivy";
/** The tool's own name, unnamespaced (see BIVY_ATTACH_MCP_SERVER_NAME). */
export const BIVY_ATTACH_TOOL_NAME = "attach_to_chat";

/**
 * Build the in-process MCP server that exposes `attach_to_chat` as a native
 * tool call (issue #291) — the stronger sibling of BIVY_ATTACH_SYSTEM_PROMPT's
 * shell-out hint: the agent sees this in its actual tool list instead of having
 * to discover a shell command from prose. Bound to one session's id so the
 * handler always attaches into the conversation that called it, regardless of
 * how many Claude sessions this node is running concurrently.
 *
 * `sdk` is the already-loaded SDK module (see loadSdk) — `tool`/
 * createSdkMcpServer are read off it dynamically for the same reason the rest
 * of this adapter never imports SDK values statically: the package is
 * optional, and a static import would force every Bivy install to have it.
 * Returns undefined if this SDK build doesn't export the MCP builder helpers
 * (older/trimmed installs) — the caller degrades to prompt-only discoverability.
 */
function buildAttachMcpServer(sdk: any, sessionId: string, attachToChat: AttachToChatFn): unknown {
  if (typeof sdk?.tool !== "function" || typeof sdk?.createSdkMcpServer !== "function") return undefined;
  const attachTool = sdk.tool(
    BIVY_ATTACH_TOOL_NAME,
    "Push a file or image from the session workspace into the chat as an attachment, exactly like the CLI `bivy attach` " +
      "or the composer's paperclip upload but as a direct tool call. Use this — not markdown image syntax, not describing " +
      "where a file lives — whenever the user should see a report, screenshot, chart, or a file they asked for; they " +
      "cannot see files you only write to disk. The path must be inside the session workspace.",
    {
      filePath: z.string().describe("Path to the file, absolute or relative to the session workspace."),
      caption: z.string().optional().describe("Short caption shown next to the attachment in the chat."),
      artifact: z
        .boolean()
        .optional()
        .describe(
          "Mark this as a named artifact — a durable output worth surfacing in the session's Artifacts list " +
            "(a report, benchmark result, coverage output, or build archive) — rather than an incidental inline image.",
        ),
    },
    async (args: { filePath: string; caption?: string; artifact?: boolean }) => {
      const result = attachToChat(sessionId, { filePath: args.filePath, caption: args.caption, ...(args.artifact ? { artifact: true } : {}) });
      if ("error" in result) return { content: [{ type: "text", text: result.error }], isError: true };
      return {
        content: [{ type: "text", text: `Attached ${result.ref.name} (${result.ref.kind}, ${result.ref.mimeType}) to the chat.` }],
      };
    },
  );
  return sdk.createSdkMcpServer({ name: BIVY_ATTACH_MCP_SERVER_NAME, tools: [attachTool] });
}

/** Adapt Bivy's runtime-agnostic ToolProvider to Claude SDK's in-process MCP
 * builder. Credentials and execution remain on the daemon. */
function buildToolProviderMcpServer(sdk: any, provider: ToolProvider): unknown {
  if (typeof sdk?.tool !== "function" || typeof sdk?.createSdkMcpServer !== "function") return undefined;
  const toShape = (schema: unknown): Record<string, z.ZodTypeAny> => {
    const object = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
    const properties = object.properties && typeof object.properties === "object" ? object.properties as Record<string, unknown> : {};
    const required = new Set(Array.isArray(object.required) ? object.required.filter((v): v is string => typeof v === "string") : []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, raw] of Object.entries(properties)) {
      const field = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      let value: z.ZodTypeAny = field.type === "string" ? z.string()
        : field.type === "integer" ? z.number().int()
          : field.type === "number" ? z.number()
            : field.type === "boolean" ? z.boolean()
              : field.type === "object" ? z.object(toShape(field)).passthrough()
                : z.unknown();
      if (Array.isArray(field.enum) && field.enum.every((v) => typeof v === "string") && field.enum.length > 0) value = z.enum(field.enum as [string, ...string[]]);
      shape[name] = required.has(name) ? value : value.optional();
    }
    return shape;
  };
  const tools = provider.list().map((spec) => sdk.tool(spec.name, spec.description, toShape(spec.parameters), async (args: unknown) => {
    const result = await provider.invoke(spec.name, `claude-${randomUUID()}`, args);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }));
  return sdk.createSdkMcpServer({ name: BIVY_ATTACH_MCP_SERVER_NAME, tools });
}

export function claudeRuntimeFromEnv(): ClaudeCodeRuntimeOptions {
  return {
    defaultModel: process.env.BIVY_CLAUDE_MODEL?.trim() || undefined,
    sessionsDir: process.env.BIVY_CLAUDE_SESSIONS_DIR?.trim() || undefined,
    executablePath: claudeCliPath(),
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

/** Model-only "meta" turns the CLI injects for its *own* benefit — task-completion
 *  notifications and injected `<system-reminder>` blocks. These are pure noise in
 *  a human transcript and must never render as chat. Kept a deliberately narrow
 *  known-tag allowlist (not "any leading <tag>") so a real user prompt that
 *  happens to start with e.g. "<div>" is never dropped. Interrupt markers are
 *  handled separately (see INTERRUPT_MARKER) because — unlike these — they carry
 *  meaning a human wants to see. */
const DROP_META_TEXT = /^\s*<(?:task-notification|system-reminder)[\s>/]/;

/** The CLI writes this synthetic user-role marker whenever a turn is aborted —
 *  by a real user Stop OR by any teardown of the streaming query (our shutdown,
 *  a mid-flight credential reload, a TUI refresh). We don't drop it: we surface
 *  it as a system notice, labeled by cause (see interruptNoticeText). */
const INTERRUPT_MARKER = /^\s*\[Request interrupted by user/;

function hasMetaFlag(entry: any): boolean {
  return entry?.isMeta === true || entry?.isCompactSummary === true || entry?.isSynthetic === true;
}

/** True when a role:"user" turn is a model-only meta injection (see
 *  DROP_META_TEXT) rather than a real human prompt. Callers must exclude
 *  tool_result-bearing turns first — those carry real tool output, never meta. */
function isDropMetaText(content: any): boolean {
  return DROP_META_TEXT.test(extractText({ content }));
}

/** True when a turn's text is the CLI's "[Request interrupted by user]" marker. */
function isInterruptText(content: any): boolean {
  return INTERRUPT_MARKER.test(extractText({ content }));
}

/** Human-facing label for an interrupt marker, classified by cause so we never
 *  blame a redeploy or a credential refresh on the user. The CLI tags any
 *  interrupt caused by tearing the process/query down (our shutdown, a
 *  credential-reload `query.close()`, a TUI refresh) with a top-level
 *  `interruptedByShutdown: true` on the transcript entry; a cooperative user
 *  Stop (`query.interrupt()`) is written without it. `forceUserStop` lets the
 *  live path assert certainty when *we* just called abort() for a real Stop.
 *  NOTE: the `interruptedByShutdown` semantics are inferred from on-disk
 *  evidence, not the (unvendored) CLI source — worth a one-time empirical check. */
function interruptNoticeText(entry: any, forceUserStop = false): string {
  if (!forceUserStop && entry?.interruptedByShutdown === true) {
    return "Interrupted — the session was restarted.";
  }
  return "Stopped by user.";
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

/** One base64-encoded image pulled out of a tool_result block. */
interface ToolResultImage {
  mimeType: string;
  data: string;
}

/** Sibling of toolResultText that keeps what that one discards: the `image`
 *  content parts of a tool_result (e.g. a Playwright/screenshot MCP tool's
 *  output), so they can be passively surfaced as chat attachments (issue #292)
 *  instead of silently vanishing. Only base64-sourced images are collected — a
 *  `url`-sourced image block (rare for a local tool) is skipped rather than
 *  fetched, since this passive path must never make its own network call. */
function toolResultImages(block: any): ToolResultImage[] {
  const content = block?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolResultImage[] = [];
  for (const part of content) {
    if (part?.type !== "image") continue;
    const source = part.source;
    if (!source || source.type !== "base64" || typeof source.data !== "string" || !source.data) continue;
    const mimeType = typeof source.media_type === "string" && source.media_type ? source.media_type : "image/png";
    out.push({ mimeType, data: source.data });
  }
  return out;
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

/**
 * Root(s) to BULK-SCAN for native session discovery (issue #156) — narrower
 * than claudeProjectDirs() above. That helper searches both CLAUDE_CONFIG_DIR
 * and the default `~/.claude` when locating one already-known session id by
 * name, which is harmless (a wrong root just doesn't have the file). Bulk
 * discovery is different: unconditionally also listing `~/.claude` would leak
 * unrelated sessions from the default store onto a node that was deliberately
 * pointed at a non-default config dir. The real `claude` CLI's own
 * CLAUDE_CONFIG_DIR handling is exclusive (it replaces the default, not adds
 * to it), so discovery mirrors that: CLAUDE_CONFIG_DIR when set, else the
 * default `~/.claude` — never both.
 */
function claudeDiscoveryRoots(): string[] {
  const custom = process.env.CLAUDE_CONFIG_DIR?.trim();
  return [custom || path.join(os.homedir(), ".claude")];
}

function findClaudeTranscript(sessionId: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) return undefined;
  const fileName = `${sessionId}.jsonl`;
  for (const root of claudeProjectDirs()) {
    const projects = path.join(root, "projects");
    try {
      const projectsRoot = fs.realpathSync(path.resolve(projects));
      for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        try {
          const projectRoot = fs.realpathSync(path.resolve(projectsRoot, project.name));
          if (!projectRoot.startsWith(`${projectsRoot}${path.sep}`)) continue;
          // Most project directories do not contain this session. Resolve each
          // candidate independently: a missing file in the first project must
          // not abort the whole store scan and hide a transcript in a later one.
          const candidate = fs.realpathSync(path.resolve(projectRoot, fileName));
          if (!candidate.startsWith(`${projectRoot}${path.sep}`)) continue;
          if (path.basename(candidate) === fileName) return candidate;
        } catch {
          continue;
        }
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
  // Indices of "the session was restarted" notices (interruptedByShutdown). A
  // restart the session *continued past* was recovered (a credential-reload
  // re-drive, or a session the user resumed), so it's noise — we keep only a
  // trailing one, where the session actually ended interrupted. See below.
  const restartNoticeIdx: number[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const rawRole = entry?.message?.role ?? entry?.role;
      const rawContent = entry?.message?.content ?? entry?.content;
      // Interrupt markers aren't dropped — surface them as a system notice,
      // labeled by cause (a real Stop vs. a teardown/restart) so history shows
      // *why* a turn ended instead of a bare, confusing user bubble. This is the
      // one place that survives a redeploy: interruptedByShutdown rides the
      // on-disk entry, so even a new process can label it correctly.
      if (rawRole === "user" && isInterruptText(rawContent)) {
        messages.push({ role: "system", content: interruptNoticeText(entry), timestamp: new Date(entry?.timestamp ?? entry?.createdAt ?? Date.now()).getTime() });
        if (entry?.interruptedByShutdown === true) restartNoticeIdx.push(messages.length - 1);
        continue;
      }
      // Drop model-only meta the CLI writes for itself (task-notifications,
      // injected reminders, compaction summaries). Flags ride the entry; the
      // text net catches the code paths that omit them. See DROP_META_TEXT.
      if (hasMetaFlag(entry)) continue;
      const role = rawRole;
      if (role !== "user" && role !== "assistant") continue;
      const content = rawContent;
      if (role === "user" && Array.isArray(content) && !content.some((block: any) => block?.type === "text" || block?.type === "tool_result")) continue;
      if (role === "user" && !(Array.isArray(content) && content.some((block: any) => block?.type === "tool_result")) && isDropMetaText(content)) continue;
      if (role === "assistant" && Array.isArray(content) && !content.some((block: any) => block?.type === "text" || block?.type === "tool_use" || block?.type === "thinking")) continue;
      if (typeof content !== "string" && !Array.isArray(content)) continue;
      messages.push({ role, content, timestamp: new Date(entry?.timestamp ?? entry?.createdAt ?? Date.now()).getTime() });
    }
  } catch {
    return dropRecoveredRestartNotices(messages, restartNoticeIdx);
  }
  return dropRecoveredRestartNotices(messages, restartNoticeIdx);
}

/** Drop "session was restarted" notices the transcript continued past (they were
 *  recovered — a credential-reload re-drive or a resumed session), keeping only a
 *  trailing one where the session actually ended interrupted. Genuine user Stops
 *  are never in `restartNoticeIdx`, so they're always kept. */
function dropRecoveredRestartNotices(messages: RuntimeMessage[], restartNoticeIdx: number[]): RuntimeMessage[] {
  if (!restartNoticeIdx.length) return messages;
  const lastIdx = messages.length - 1;
  const drop = new Set(restartNoticeIdx.filter((i) => i !== lastIdx));
  return drop.size ? messages.filter((_, i) => !drop.has(i)) : messages;
}

/**
 * Cheap, bounded per-file scan for native discovery (issue #156) — deliberately
 * NOT loadClaudeTranscript: that reconstructs the full conversation, which is
 * exactly the transcript CONTENT discovery must never carry. This reads only
 * the first recorded `cwd` and a truncated first user prompt, stopping the
 * moment both are found, plus the file's mtime as a last-activity proxy.
 * Best-effort: any read/parse failure yields whatever was found so far (or
 * undefined if the file itself is unreadable).
 */
function scanClaudeSessionForDiscovery(file: string): { cwd?: string; updatedAt?: number; title?: string } | undefined {
  let updatedAt: number | undefined;
  try {
    updatedAt = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  let cwd: string | undefined;
  let title: string | undefined;
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (cwd && title) break;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof entry?.cwd === "string") cwd = entry.cwd;
      if (!title) {
        const role = entry?.message?.role ?? entry?.role;
        const content = entry?.message?.content ?? entry?.content;
        if (role === "user" && !hasMetaFlag(entry) && !isInterruptText(content)) {
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content.find((b: any) => b?.type === "text")?.text as string | undefined)
              : undefined;
          if (text?.trim()) title = text.trim().slice(0, 200);
        }
      }
    }
  } catch {
    // best-effort — whatever cwd/title were found before the failure still stand
  }
  return { cwd, updatedAt, title };
}

/**
 * Enumerate Claude Code's on-disk sessions — from claudeDiscoveryRoots()
 * (CLAUDE_CONFIG_DIR when set, else `~/.claude`, so a non-default provider
 * home is honored and never mixed with the default store) — as bounded
 * discovery metadata. Every session on disk has a stable id (the jsonl
 * filename) Claude resumes by, so `resumable` is always true; `active` is a
 * best-effort live-process check scoped to the session's own cwd. Best-effort
 * throughout: an unreadable store yields fewer results, never a throw.
 */
export function discoverNativeClaudeSessions(
  hasLiveProcess: (cwd: string) => boolean = (cwd) => hasLiveProcessForCwd(cwd, CLAUDE_BIN_NAMES),
): DiscoveredNativeSession[] {
  const out: DiscoveredNativeSession[] = [];
  const seenIds = new Set<string>();
  for (const root of claudeDiscoveryRoots()) {
    const projectsDir = path.join(root, "projects");
    let projectEntries: fs.Dirent[];
    try {
      projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue; // no store at this root — best-effort, try the next one
    }
    for (const project of projectEntries) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsDir, project.name);
      let files: string[];
      try {
        files = fs.readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const fileName of files) {
        const sessionId = fileName.slice(0, -".jsonl".length);
        if (!sessionId || seenIds.has(sessionId)) continue;
        seenIds.add(sessionId);
        const meta = scanClaudeSessionForDiscovery(path.join(projectDir, fileName));
        if (!meta) continue;
        out.push({
          runtimeId: "claude-code-sdk",
          ref: sessionId,
          file: path.join(projectDir, fileName),
          cwd: meta.cwd,
          updatedAt: meta.updatedAt,
          title: meta.title,
          active: Boolean(meta.cwd) && hasLiveProcess(meta.cwd!),
          resumable: true,
        });
      }
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
  /** Set when *we* call abort() for a genuine user Stop, so the resulting
   *  "[Request interrupted by user]" marker is labeled "Stopped by user" with
   *  certainty rather than relying on the CLI's interruptedByShutdown flag.
   *  Cleared once the marker is consumed or the turn otherwise ends. */
  private userAbortPending = false;
  /** Set when we tear the query down for a *credential reload*, which the CLI
   *  records as an interrupt even though the turn transparently re-drives and
   *  completes. Suppresses the resulting marker so it never flashes an
   *  "interrupted" notice. One-shot; cleared when consumed, on the next result,
   *  and on a real abort() (a user Stop must never be silenced by a stale flag). */
  private suppressNextInterrupt = false;

  /** tool_use id → tool name, learned as "assistant" turns emit tool_use blocks.
   *  Used only to label a passively-surfaced tool_image (see #292); never
   *  cleared mid-session since a tool_use_id is unique for the session's life. */
  private readonly toolNamesByUseId = new Map<string, string>();
  private readonly toolDetailsByUseId = new Map<string, ReturnType<typeof mapToolCall>>();
  /** This turn's passive-image noise guard (see PassiveImageBudget); replaced
   *  with a fresh budget at the start of every prompt(). */
  private passiveImageBudget = new PassiveImageBudget();

  /** The agent's own slash commands for this session, learned from the SDK's
   *  system/init message (slash_commands + skills). Empty until the first turn's
   *  init arrives; getCommands() exposes them and a `runtime.commands` event lets
   *  the daemon re-advertise once they're known. */
  private commands: AgentCommand[] = [];

  constructor(
    private readonly runtimeOptions: ClaudeCodeRuntimeOptions,
    public readonly cwd: string,
    private readonly toolInterceptor: ToolInterceptor | undefined,
    private readonly toolProvider: ToolProvider | undefined,
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
    const env: Record<string, string> = { ...process.env, ...depCacheEnv(this.cwd), ...this.runtimeOptions.env } as Record<string, string>;
    const credEnv = await this.resolveCredentialEnv();
    Object.assign(env, credEnv);
    // Let the agent's own shell surface a file into the chat via `bivy attach`
    // (POST /api/session/:id/attach). The session id is otherwise invisible to
    // the subprocess. Shared with process.ts and protocol.ts via bivySessionEnv
    // (see session-env.ts) so every CLI-spawning adapter injects it the same way.
    Object.assign(env, bivySessionEnv(this.id));
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
      // Keep the default Claude Code prompt, appending the note that teaches the
      // agent how to send a file to the user (`bivy attach`) — otherwise the
      // capability is undiscoverable and "send me X as an attachment" fails.
      // Kept even when the native tool below is also registered: it's a cheap,
      // harmless fallback for a shell/subprocess the agent spawns that can't
      // reach the in-process MCP tool directly.
      systemPrompt: { type: "preset", preset: "claude_code", append: BIVY_ATTACH_SYSTEM_PROMPT },
      ...(this.runtimeOptions.executablePath ? { pathToClaudeCodeExecutable: this.runtimeOptions.executablePath } : {}),
    };
    if (resumeId) options.resume = resumeId;
    else options.sessionId = this.id;
    if (this.desiredModel) options.model = this.desiredModel;
    // Native attach_to_chat tool (issue #291) — the stronger, tool-based sibling
    // of the system-prompt hint above. Wired only when the daemon handed us a
    // callback (see ClaudeCodeRuntimeOptions.attachToChat); absent in a few
    // deliberately minimal test harnesses, and gracefully degrades to the prompt
    // hint alone if this SDK build lacks the MCP builder helpers.
    const bivyServer = this.toolProvider
      ? buildToolProviderMcpServer(sdk, this.toolProvider)
      : this.runtimeOptions.attachToChat
        ? buildAttachMcpServer(sdk, this.id, this.runtimeOptions.attachToChat)
        : undefined;
    if (bivyServer) options.mcpServers = { [BIVY_ATTACH_MCP_SERVER_NAME]: bivyServer };

    const q = sdk.query({ prompt: this.input, options });
    this.query = q;
    void this.consume(q);

    // Best-effort: warm the model picker once the agent is up. getModels()
    // re-queries on every call too, so a long-running session's list never
    // freezes on whatever the query reported at spawn.
    void this.refreshSupportedModels();
  }

  /**
   * Re-read the live query's authoritative model list and brand each row to the
   * product's naming. Called from getModels() (and once at spawn) so the picker
   * reflects the current lineup rather than the set captured when the query
   * first spawned — a long session used to keep a stale catalog. Best-effort:
   * on any failure (query torn down mid-reload, or an SDK build without the
   * call) it leaves the last-known list in place.
   */
  private async refreshSupportedModels(): Promise<void> {
    const q: any = this.query;
    if (!q || typeof q.supportedModels !== "function") return;
    // Bound the wait: supportedModels() resolves instantly once the query has
    // initialized, but getModels() is on the models.list request path, so a
    // hung subprocess must not freeze the picker — fall back to the last-known
    // list (or FALLBACK_MODELS) instead of blocking.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1500); }),
      ]);
      if (Array.isArray(models) && models.length) this.models = models.map((m) => brandClaudeModel(toModelInfo(m)));
    } catch {
      // Keep the last-known list (getModels() falls back to FALLBACK_MODELS if empty).
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Spin up the agent subprocess *without* sending a prompt, purely so
   * supportedModels() can resolve and the picker shows the account's real,
   * current lineup instead of FALLBACK_MODELS. Used to warm a not-yet-started
   * (e.g. draft/new-session) catalog. Gated on credentials — mirroring prompt()'s
   * preflight — so we never spawn a subprocess that would only fail; without a
   * credential the picker simply keeps the placeholder list. Best-effort and
   * idempotent: once the query is up it just re-reads the list.
   */
  async warmModels(): Promise<void> {
    if (this.query) return this.refreshSupportedModels();
    try {
      const env = { ...process.env, ...depCacheEnv(this.cwd), ...this.runtimeOptions.env, ...(await this.resolveCredentialEnv().catch(() => ({}))) } as Record<string, string>;
      if (anthropicCredentialPreflight(env)) return; // no credential — keep FALLBACK_MODELS
      await this.ensureStarted();
      await this.refreshSupportedModels();
    } catch {
      // Spawn/credential failure — the picker keeps FALLBACK_MODELS.
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
  private async restartWithFreshCredential(rejectedToken?: string): Promise<boolean> {
    if (this.reloading) return false;
    this.reloading = true;
    try {
      // On a provider 401, identify the bearer that failed so the resolver can
      // refresh it immediately even if its expiry claims it is still valid.
      // The resolver compares this under the vault lock, making concurrent
      // failures converge on one rotation.
      const credEnv = await this.resolveCredentialEnv(rejectedToken).catch(() => ({} as Record<string, string>));
      const nextToken = authTokenFromEnv(credEnv);
      if (!nextToken || nextToken === this.spawnedToken) return false;
      this.emit({ type: "session.notice", level: "info", message: "Refreshing credentials…" });
      // This teardown makes the CLI write an interrupt marker, but the turn is
      // re-driven and completes — so suppress that marker rather than blaming a
      // phantom interrupt on the user (the "Refreshing credentials…" notice above
      // already tells the human what happened).
      this.suppressNextInterrupt = true;
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
  private async resolveCredentialEnv(rejectedToken?: string): Promise<Record<string, string>> {
    const store = this.runtimeOptions.credentials;
    if (!store) return {};
    const provider = this.runtimeOptions.credentialProvider?.trim() || "anthropic";
    let cred;
    try {
      cred = await store.getCredential(provider, { workspace: this.cwd, ...(rejectedToken ? { rejectedToken } : {}) });
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
      for await (const message of q) await this.handle(message);
    } catch (error) {
      this.streaming = false;
      const raw = error instanceof Error ? error.message : String(error);
      if (await this.recoverFromAuthError(raw)) return;
      // Emit session.error (the toast path) — agent_end's `error` field is not
      // surfaced by the client, so without this a thrown SDK error (e.g. a 401)
      // stopped the turn silently. Auth failures get sign-in guidance appended.
      this.emit({ type: "session.error", error: describeAnthropicError(raw) });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end", error: raw });
    }
  }

  /** Recover a provider 401 regardless of whether the SDK throws it, emits it as
   * assistant text, or puts it in an error result. The latter is how revoked
   * OAuth tokens commonly arrive, so only handling consume()'s catch would leave
   * the turn stopped until the user sent another message. */
  private async recoverFromAuthError(raw: string): Promise<boolean> {
    if (!isAnthropicAuthError(raw) || this.reloadedThisTurn || this.inFlightPrompt === undefined) return false;
    this.reloadedThisTurn = true;
    if (!(await this.restartWithFreshCredential(this.spawnedToken))) return false;
    this.streaming = true;
    this.input.push({ type: "user", message: { role: "user", content: this.inFlightPrompt }, parent_tool_use_id: null });
    return true;
  }

  private beginMessage(): void {
    if (this.startedMessage) return;
    this.startedMessage = true;
    this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
  }

  /**
   * Passively surface any images riding home on a tool_result (issue #292) —
   * e.g. a Playwright/screenshot MCP tool's output, which toolResultText above
   * deliberately drops. Gated by autoAttachToolImagesEnabled() at the call site
   * and bounded here by this turn's PassiveImageBudget so a chatty tool can't
   * flood the transcript; a drop is logged (with the responsible tool's name)
   * rather than silently discarded. Emits one `tool_image` RuntimeEvent per
   * admitted image; src/server.ts's session listener does the actual
   * store+persist+broadcast, the same way an explicit `bivy attach` does.
   */
  private emitPassiveToolImages(block: any): void {
    const images = toolResultImages(block);
    if (!images.length) return;
    const toolUseId = String(block.tool_use_id ?? "");
    const toolName = this.toolNamesByUseId.get(toolUseId) ?? "tool";
    for (const image of images) {
      const byteLength = Buffer.byteLength(image.data, "base64");
      if (!this.passiveImageBudget.admit(byteLength)) {
        console.warn(
          `[claude-code] dropped a passively-surfaced tool image from "${toolName}" (tool_use_id=${toolUseId}, ~${byteLength} bytes): ${this.passiveImageBudget.droppedSummary()}`,
        );
        continue;
      }
      this.emit({ type: "tool_image", toolUseId, toolName, mimeType: image.mimeType, data: image.data });
    }
  }

  private async handle(message: any): Promise<void> {
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
        // Compaction summaries and other meta assistant turns are for the model,
        // not the human — never persist or surface them as chat.
        if (hasMetaFlag(message)) break;
        // Claude Code sometimes reports auth failures as an ordinary assistant
        // text message rather than throwing. Intercept it before it is persisted
        // or shown, refresh, and transparently continue the same prompt.
        const assistantText = extractText(message.message);
        if (assistantText && await this.recoverFromAuthError(assistantText)) break;
        const model = message.message?.model;
        if (model) this.currentModel = toModelInfo({ id: model });
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === "tool_use") {
            const detail = mapToolCall(String(block.name ?? "tool"), block.input, { provider: "claude", protocol: "sdk" });
            if (detail && typeof block.id === "string") this.toolDetailsByUseId.set(block.id, detail);
            this.emit({ type: "tool_call", toolName: block.name, input: block.input, toolUseId: block.id, ...(detail ? { detail } : {}) });
            if (typeof block.id === "string" && typeof block.name === "string") this.toolNamesByUseId.set(block.id, block.name);
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
            const prior = this.toolDetailsByUseId.get(String(block.tool_use_id));
            const resultText = toolResultText(block);
            const detail = prior ? { ...prior, result: mapToolResult(resultText, Boolean(block.is_error)) } : undefined;
            this.emit({ type: "tool_result", toolUseId: block.tool_use_id, result: resultText, isError: Boolean(block.is_error), ...(detail ? { detail } : {}) });
            if (autoAttachToolImagesEnabled()) this.emitPassiveToolImages(block);
          }
          this.emit({ type: "user", raw: message });
          break;
        }
        // Interrupt marker: surface a system notice (never a user bubble),
        // labeled by cause. If *we* just called abort() for a real user Stop
        // (userAbortPending), that's authoritative; otherwise fall back to the
        // CLI's interruptedByShutdown flag to tell a teardown/restart apart from
        // a genuine Stop. Persist it (role:"system") so it survives reopen, and
        // emit a live notice so it shows immediately.
        if (isInterruptText(userContent)) {
          // A credential-reload teardown produced this marker; the turn re-drives
          // and completes transparently, so a notice would just be noise.
          if (this.suppressNextInterrupt) {
            this.suppressNextInterrupt = false;
            break;
          }
          const notice = interruptNoticeText(message, this.userAbortPending);
          this.userAbortPending = false;
          this.messages.push({ role: "system", content: notice, timestamp: Date.now() });
          this.emit({ type: "session.notice", level: "info", message: notice });
          break;
        }
        // Otherwise: the human's own prompt echo, or a model-only meta turn
        // (injected reminder / task-notification). Drop meta so it never renders
        // as a chat bubble; forward a real prompt echo unchanged.
        if (hasMetaFlag(message) || isDropMetaText(userContent)) break;
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
        const resultError = message.subtype && message.subtype !== "success" ? String(message.result ?? message.subtype) : "";
        if (resultError && await this.recoverFromAuthError(resultError)) break;
        this.streaming = false;
        this.startedMessage = false;
        this.currentText = "";
        // The turn ended; clear both interrupt flags so a stale one can't
        // mislabel or wrongly suppress a later interrupt.
        this.userAbortPending = false;
        this.suppressNextInterrupt = false;
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
        // Task-completion notifications and compaction boundaries are injected
        // for the model, not the human — don't forward them as chat. (init still
        // falls through so its capabilities/commands reach the client.)
        if (message?.subtype === "task_notification" || message?.subtype === "compact_boundary") break;
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
    // Fresh per-turn noise-guard budget (see PassiveImageBudget) — a prior
    // turn's usage must never carry over and eat into this one's allowance.
    this.passiveImageBudget = new PassiveImageBudget();
    // Credential preflight (first turn only): if no Anthropic credential will
    // reach the SDK, surface an actionable message instead of letting it spawn
    // and fail its first request with an opaque `401 Unauthorized`.
    if (!this.query) {
      const env = { ...process.env, ...depCacheEnv(this.cwd), ...this.runtimeOptions.env, ...(await this.resolveCredentialEnv().catch(() => ({}))) } as Record<string, string>;
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
    // Mark this as a genuine, user-initiated Stop so the interrupt marker the
    // CLI is about to write is labeled with certainty (not via the shutdown
    // flag). Clear any stale credential-reload suppression — a user Stop must
    // always be shown, never silenced.
    this.userAbortPending = true;
    this.suppressNextInterrupt = false;
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

  async getModels(): Promise<ModelInfo[]> {
    // Re-query the live agent so the picker reflects the current lineup instead
    // of the set captured when the query first spawned. Before the query is up
    // (or if supportedModels() failed/returned nothing) fall back to the known
    // lineup so the picker is never empty.
    await this.refreshSupportedModels();
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

    const env = { ...process.env, ...depCacheEnv(this.cwd), ...this.runtimeOptions.env, ...(await this.resolveCredentialEnv()) } as Record<string, string>;
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
  readonly capabilities: RuntimeCapabilities = withExactCapabilitySurface({
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
    // Claude can also synthesise a resumable jsonl from portable {role,text}
    // history, so a fork FROM another agent INTO claude is a true replay of the
    // whole transcript rather than a seeded summary (see importHistoryForFork).
    forkHistoryImport: true,
    // Claude Code ignores the streamingBehavior hint entirely — a mid-turn
    // prompt always re-enters the live input queue and behaves like an
    // immediate steer, regardless of what's asked for. There is no real
    // "followUp" (defer until the turn ends) here, so only advertise steer.
    streamingBehaviors: ["steer"],
    // Claude sessions started outside Bivy (a bare `claude` in a terminal) are
    // discoverable across claudeProjectDirs() and every discovered session can
    // be adopted with a true native resume (see discoverNativeSessions below).
    nativeSessionDiscovery: true,
    nativeSessionAdoption: true,
  });

  private readonly sessions: ClaudeSession[] = [];

  constructor(private readonly options: ClaudeCodeRuntimeOptions = {}) {}

  /** Claude Code runs Anthropic models; the authoritative list comes from the
   *  live query per session, so the session-less catalog is the known lineup. */
  listCatalog(): CatalogProvider[] {
    return [{ id: "anthropic", name: "Anthropic", oauth: true, models: FALLBACK_MODELS }];
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new ClaudeSession(this.options, options.workspace, options.toolInterceptor, options.toolProvider);
    this.sessions.push(session);
    return { session };
  }

  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    const session = new ClaudeSession(this.options, options.workspace, options.toolInterceptor, options.toolProvider, options.sessionFile);
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

  /** See discoverNativeClaudeSessions — enumerates Claude sessions on this node
   *  that Bivy didn't start, as bounded metadata (issue #156). */
  discoverNativeSessions(): DiscoveredNativeSession[] {
    try {
      return discoverNativeClaudeSessions();
    } catch {
      return [];
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
    ctx: ForkImportContext,
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

  /**
   * Stand up a claude session from a **cross-runtime** fork's portable history:
   * synthesise a resumable jsonl transcript from the `{role, text}` turns and
   * write it under the destination cwd's project dir with a fresh session id, so
   * `--resume <id>` opens on a copy of the whole conversation (fidelity
   * "replayed"). Each turn becomes one claude jsonl entry whose `message` is a
   * plain-text user/assistant message — the same shape loadClaudeTranscript reads
   * back — chained by `uuid`/`parentUuid` exactly as claude's own transcripts are.
   * Tool activity is already inlined as text upstream, so no `tool_use`/
   * `tool_result` blocks (whose ids would dangle) are ever emitted. The source is
   * never touched.
   */
  async importHistoryForFork(
    history: ForkHistoryMessage[],
    ctx: ForkImportContext,
  ): Promise<{ sessionFile: string; id: string }> {
    const newId = randomUUID();
    const cwd = ctx.cwd || ctx.workspace;
    // Claude encodes the cwd into the project-dir name by replacing every
    // non-alphanumeric char with "-" (matches importForFork above).
    const projectSlug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const root = claudeProjectDirs()[0] ?? path.join(os.homedir(), ".claude");
    const projectDir = path.join(root, "projects", projectSlug);
    fs.mkdirSync(projectDir, { recursive: true });
    let parentUuid: string | null = null;
    const model = ctx.model?.provider === "anthropic"
      ? ctx.model.id
      : this.options.defaultModel ?? FALLBACK_MODELS.find((candidate) => candidate.id.includes("sonnet"))!.id;
    const timestamp = Date.now();
    const lines = history.map((turn, index) => {
      const uuid = randomUUID();
      // Claude's store is permissive when read for display, but `--resume` / the
      // Agent SDK expects provider-native assistant envelopes. Keep the portable
      // history generic until this final serializer, then emit the same minimum
      // shape as a real Claude transcript (content blocks, model/id, stop reason,
      // usage and timestamps). This is the Claude counterpart to pi's native
      // serializer and prevents a replay that paints correctly but fails on the
      // first continued prompt.
      const message = turn.role === "user"
        ? { role: "user", content: turn.text }
        : {
            model,
            id: `msg_bivy_${uuid.replace(/-/g, "")}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: turn.text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          };
      const entry = {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId: newId,
        type: turn.role,
        message,
        uuid,
        timestamp: new Date(timestamp + index).toISOString(),
      };
      parentUuid = uuid;
      return JSON.stringify(entry);
    });
    fs.writeFileSync(path.join(projectDir, `${newId}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
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
