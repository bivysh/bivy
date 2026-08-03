// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Runtime registry. Selects the agent runtime by BIVY_RUNTIME (default "pi").
// This is the seam where additional runtimes (Claude Agent SDK, generic RPC,
// …) are registered without touching the daemon.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRuntime, claudeRuntimeFromEnv, claudeSdkInstalled } from "./claude-code.js";
import { deleteCodexSession, discoverNativeCodexSessions, loadCodexTranscript, writeCodexRollout } from "./codex-sessions.js";
import { createCredentialStore } from "./credentials.js";

// Args that continue an existing Codex session each prompt. Codex assigns its own
// session id (no launch-time pin), so a resumed run threads it via `exec resume`.
// The exact flags vary by Codex version, so `BIVY_CODEX_RESUME_TEMPLATE` (a JSON
// array with `{id}` / `{tier}` placeholders) overrides this without a code change.
function codexResumeArgs(sessionId: string, tier: string): string[] {
  const raw = process.env.BIVY_CODEX_RESUME_TEMPLATE?.trim();
  if (raw) {
    try {
      const tpl = JSON.parse(raw);
      if (Array.isArray(tpl)) return tpl.map((a) => String(a).replace(/\{id\}/g, sessionId).replace(/\{tier\}/g, tier));
    } catch {
      // malformed override — fall through to the default
    }
  }
  // `--json` and `--sandbox` are options of `codex exec`, not of the `resume`
  // subcommand, so they must precede `resume` — otherwise clap rejects them with
  // "unexpected argument '--sandbox'". Verified against codex-cli 0.142.5 and
  // 0.144.1. Bivy's SandboxTier values are exactly Codex's --sandbox modes
  // (read-only | workspace-write | danger-full-access), so `tier` needs no mapping.
  return ["exec", "--json", "--sandbox", tier, "resume", sessionId];
}
import type { ModelInfo, RuntimeMessage } from "./types.js";
import { PiRuntime, type PiRuntimeOptions } from "./pi.js";
import { ProcessRuntime, processRuntimeFromEnv, type ProcessModelConfig, type ProcessPromptMode, type ProcessThinkingConfig } from "./process.js";
import { codexCredentialPreflight } from "./codex-preflight.js";
import { opencodeCredentialPreflight } from "./opencode-preflight.js";
import { ensureCodexAuth } from "./codex-auth.js";
import { parserFactoryFor } from "./cli-parsers.js";
import { sandboxTier, sandboxArgsFor, codexSandboxPolicy, type SandboxTier } from "../harness/sandbox.js";
import { ProtocolRuntime, protocolRuntimeFromEnv, protocolCommandsFromEnv, type ProtocolRuntimeOptions } from "./protocol.js";
import type { AgentRuntime, AttachToChatFn, RuntimeCapabilities } from "./types.js";

export * from "./types.js";
export { NodeCredentialResolver, createCredentialStore } from "./credentials.js";

export interface RuntimeFactoryOptions extends PiRuntimeOptions {
  /** Override the runtime; defaults to BIVY_RUNTIME or "pi". */
  runtime?: string;
  /** Per-session sandbox tier override (else the node default is used). */
  sandbox?: SandboxTier;
  /**
   * Backs each runtime's native "attach to chat" tool surface (issue #291) —
   * threaded to the Claude adapter's ClaudeCodeRuntimeOptions.attachToChat.
   * Absent = no native tool is registered (the node falls back to whatever
   * discoverability hint that runtime carries, e.g. Claude's system-prompt note).
   */
  attachToChat?: AttachToChatFn;
}

export type RuntimeStatus = "available" | "planned" | "external";
export type RuntimeSupportTier = "supported" | "beta" | "experimental" | "planned";

export interface RuntimeInstallInfo {
  label: string;
  description?: string;
  /** Human-readable command shown to the user; execution remains server allowlisted. */
  command: string;
}

export interface RuntimeInfo {
  id: string;
  displayName: string;
  description: string;
  status: RuntimeStatus;
  packageName?: string;
  language?: string;
  capabilities: Partial<RuntimeCapabilities>;
  supportTier: RuntimeSupportTier;
  /** Who owns the first-run credential/login UX for this runtime. */
  authOwner?: "bivy" | "agent" | "mixed";
  notes?: string;
  install?: RuntimeInstallInfo;
}

const PI_CAPABILITIES: RuntimeCapabilities = {
  toolInterception: true,
  modelSelection: true,
  packages: true,
  resume: true,
  fork: false,
  interactiveTui: true,
  usageReporting: true,
  sessionDiscovery: true,
  // Must match PiRuntime.capabilities (src/runtime/pi.ts) — the composer reads
  // steer support from the session-less runtimes.list catalog, so if this drifts
  // from the live runtime the client never learns steering is available and
  // force-queues every mid-turn message instead of offering an immediate send.
  streamingBehaviors: ["steer", "followUp"],
};

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  toolInterception: true,
  modelSelection: true,
  packages: false,
  resume: true,
  fork: true,
  usageReporting: true,
  // Sessions started outside Bivy (a bare `claude` in a terminal) are
  // discoverable and adoptable with a true native resume — see issue #156 and
  // ClaudeCodeRuntime.discoverNativeSessions.
  nativeSessionDiscovery: true,
  nativeSessionAdoption: true,
  // Must match ClaudeCodeRuntime.capabilities (src/runtime/claude-code.ts): a
  // mid-turn prompt re-enters the SDK streaming-input queue and behaves as an
  // immediate steer. Advertised here too so the composer offers "send now"
  // straight from runtimes.list — before any session-capabilities merge, which
  // won't fire on a reconnect to an already-running session (the mobile case).
  streamingBehaviors: ["steer"],
};

function claudeCodeInfo(): RuntimeInfo {
  const installed = claudeSdkInstalled();
  return {
    id: "claude-code-sdk",
    displayName: "Claude Code SDK",
    description: "Anthropic's Claude Agent SDK driven as a Bivy runtime: streaming turns, model picker, and tool approvals via the SDK permission callback.",
    status: installed ? "available" : "planned",
    packageName: "@anthropic-ai/claude-agent-sdk",
    language: "TypeScript",
    // The interactive TUI is a chat<->CLI hand-off; only advertise it when the
    // standalone `claude` CLI is actually installed on this node.
    capabilities: { ...CLAUDE_CAPABILITIES, interactiveTui: commandAvailable("claude") },
    supportTier: "supported",
    authOwner: "mixed",
    notes: installed
      ? "Multi-turn sessions over a streaming-input query(); approvals map to canUseTool. Set BIVY_CLAUDE_MODEL to pick a default model."
      : "Install @anthropic-ai/claude-agent-sdk to enable this runtime (npm install @anthropic-ai/claude-agent-sdk).",
    install: installed ? undefined : {
      label: "Install Claude Code SDK",
      description: "Installs the optional Anthropic SDK package into this Bivy node.",
      command: "npm install @anthropic-ai/claude-agent-sdk",
    },
  };
}

function commandAvailable(command: string): boolean {
  if (!command.trim()) return false;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function genericCliInfo(): RuntimeInfo {
  const options = processRuntimeFromEnv();
  const configured = Boolean(options);
  // Same generic primitive as the built-in CLI agents: honest only when
  // BIVY_AGENT_RESUME_TEMPLATE actually wired resumeArgs (see processRuntimeFromEnv).
  const resume = Boolean(options?.resumeArgs);
  return {
    id: "generic-cli",
    displayName: process.env.BIVY_AGENT_NAME?.trim() || "Generic CLI Agent",
    description: "Run any local agent CLI underneath Bivy by spawning a configured process and streaming stdout/stderr.",
    status: configured ? "available" : "planned",
    packageName: process.env.BIVY_AGENT_COMMAND?.trim() || "Set BIVY_AGENT_COMMAND",
    language: "Process",
    capabilities: { toolInterception: false, modelSelection: false, resume, packages: false, fork: false },
    supportTier: "experimental",
    authOwner: "agent",
    notes: configured
      ? `Configured through BIVY_AGENT_COMMAND / BIVY_AGENT_ARGS / BIVY_AGENT_PROMPT_MODE. Provides universal streaming but not structured approvals unless the agent speaks Bivy protocol.${resume ? " Resumable via BIVY_AGENT_RESUME_TEMPLATE." : " Set BIVY_AGENT_RESUME_TEMPLATE (a JSON arg array with {id}) if the configured agent has its own \"continue session <id>\" flag."}`
      : "Set BIVY_AGENT_COMMAND to enable this universal CLI runtime.",
  };
}

type CliAgentId =
  | "codex"
  | "opencode"
  | "aider"
  | "hermes"
  | "goose"
  | "gemini"
  | "qwen"
  | "cline"
  | "crush"
  // Second wave — the next tranche of the most-used coding-agent CLIs, all wired
  // purely as data on the same ProcessRuntime + CliParser path (no bespoke
  // per-agent code). "codebuff" is defined but hidden from the picker (like
  // "hermes"): it has no verified non-TTY headless mode upstream yet.
  | "cursor"
  | "copilot"
  | "grok"
  | "amp"
  | "auggie"
  | "droid"
  | "continue"
  | "kilocode"
  | "rovodev"
  | "codebuff";

/**
 * Structured install descriptor — the single source of truth consumed by (a) the
 * catalog "Install" button, (b) the server auto-install endpoint
 * (`runtimeInstallSpec`), and (c) the terminal CLI's bundled-agent manifest
 * (`bin/agent-manifest.json`). Absent = installed out of band, so no auto-install
 * button/spec is offered (honest). `{bin}` in a curl `shell` expands to the
 * node's `<prefix>/bin` so scripts can drop a binary where PATH already looks.
 */
type CliInstall =
  | { kind: "npm"; pkg: string }
  | { kind: "pip"; pkg: string }
  | { kind: "curl"; display: string; shell: string };

type CliAgentSpec = {
  displayName: string;
  command: string;
  packageName: string;
  promptMode: ProcessPromptMode;
  /**
   * Hidden from the agent picker (still runnable via `BIVY_RUNTIME=<id>`). The
   * honest home for an agent whose ProcessRuntime capabilities aren't picker-grade
   * yet — e.g. `codex` (superseded by the governed `codex-approvals` shim),
   * `hermes` (no structured parser/resume), and `codebuff` (no verified non-TTY
   * headless mode). Everything else defaults to visible.
   */
  hidden?: boolean;
  /** Structured, data-driven install descriptor (see CliInstall). */
  install?: CliInstall;
  /** Support tier surfaced in the picker. Defaults to "beta". */
  supportTier?: RuntimeSupportTier;
  /** Who owns the first-run credential/login UX. Defaults to "agent". */
  authOwner?: "bivy" | "agent" | "mixed";
  /** One-line human blurb for the catalog; falls back to a generic sentence. */
  blurb?: string;
  /**
   * Generic resume primitive (the O(1) scaling path — data, not per-agent code).
   * `template` is the arg array that continues a prior session, with `{id}` → the
   * agent's own session ref, `{tier}` → the raw sandbox tier, and `{sandbox}` →
   * that agent's native containment flag(s) for the tier (the same array
   * `sandboxArgsFor` would splice into a fresh launch — e.g. Gemini/Qwen's
   * `--approval-mode <mode>`), so a resumed turn stays contained the same way a
   * fresh one would. When present (or when an operator sets
   * `BIVY_<ID>_RESUME_TEMPLATE`), the runtime advertises resume and threads the id
   * each prompt via ProcessRuntime.resumeArgs. Absent = a fresh process per prompt
   * (resume stays off, and the catalog reports it off) — the honest state for an
   * agent with no native "continue session <id>" form (e.g. Aider, Crush).
   */
  resume?: { template: string[]; loadHistory?: (sessionId: string) => RuntimeMessage[] };
  /**
   * Model selection, the data-driven way. `flag` is the CLI's model option (its
   * value is the chosen model id); `insertAt` places it in the launch args (0 =
   * prepend, 1 = after a leading subcommand like `run`); `models` is the curated
   * default list. An operator can override the list with `BIVY_<ID>_MODELS` (JSON
   * `[{id,name?,provider?}]`). Absent = the agent runs on its own default and the
   * catalog reports modelSelection off.
   */
  model?: { flag: string; insertAt?: number; models: Array<{ id: string; name?: string; provider?: string }> };
  /**
   * Reasoning-effort / thinking-level selection (data-driven, same shape as
   * `model`). `template` is the arg array that selects a level, with `{level}` →
   * the chosen level; `insertAt` places it in the launch args. An operator can
   * enable/override it for any agent via `BIVY_<ID>_THINKING` (JSON
   * `{levels,template,insertAt?,default?}`). Absent = supportsThinking() is false.
   */
  thinking?: { levels: string[]; default?: string; template: string[]; insertAt?: number };
  args?: string[];
  /**
   * Phase 4 — structured mode. When set, Bivy launches the agent with `jsonArgs`
   * (its native JSON output flags) instead of `args`, and parses stdout with the
   * `parserId` CliParser for full chat fidelity. Validated against the real CLIs.
   * Disable with BIVY_AGENT_STRUCTURED=0 to fall back to the dumb-pipe args.
   */
  jsonArgs?: string[];
  parserId?: string;
  /**
   * The `parserId` is a tolerant, format-agnostic parser (generic-stream-json /
   * generic-json) whose flag+schema we haven't validated against the real binary
   * yet. Such agents stay on the safe dumb-pipe path by DEFAULT — flipping them to
   * structured could regress a working agent if a flag is wrong — but an operator
   * can opt in globally with `BIVY_AGENT_STRUCTURED=1`. Once validated, drop this
   * flag and the agent gets structured fidelity by default (a one-field edit).
   */
  parserUnverified?: boolean;
  /**
   * Native exec sandbox. When set, builds the full launch args for a given
   * structured-mode + sandbox tier, inserting the agent's native sandbox/approval
   * flags in the right place (the prompt is appended by ProcessRuntime after
   * these). Takes precedence over args/jsonArgs. Agents without a native sandbox
   * omit this and fall back to args/jsonArgs.
   */
  composeArgs?: (opts: { structured: boolean; tier: SandboxTier }) => string[];
  /**
   * The agent speaks the Agent Client Protocol (ACP) — the highest-capability
   * general wrapping path. `args` launches it in ACP mode (e.g. Gemini's
   * `["--experimental-acp"]`). When set AND preferred (per-agent `BIVY_<ID>_ACP=1`
   * or global `BIVY_PREFER_ACP=1`), the agent is driven through bin/acp-shim.mjs →
   * the governed ProtocolRuntime (per-tool approvals + streaming + resume) INSTEAD
   * of the one-shot stdout pipe — no other spec change needed. Off by default until
   * validated for the agent, keeping the pipe path (and honest capabilities) intact.
   */
  acp?: { args: string[] };
};

const CLI_AGENT_SPECS: Record<CliAgentId, CliAgentSpec> = {
  codex: {
    displayName: "Codex",
    command: "codex",
    // Bare `codex "<prompt>"` launches the interactive TUI, which needs a real
    // TTY and dies with "stdin is not a terminal" when driven over a pipe. The
    // `exec` subcommand is Codex's non-interactive mode: it takes the prompt as
    // an argument, runs headless, and streams the result to stdout.
    args: ["exec"],
    // `codex exec --json` streams a thread/turn/item JSONL event model.
    jsonArgs: ["exec", "--json"],
    parserId: "codex-json",
    // `codex exec --json --sandbox <tier> <prompt>` — native OS sandbox.
    composeArgs: ({ structured, tier }) => ["exec", ...(structured ? ["--json"] : []), "--sandbox", tier],
    // Reasoning effort via a config override, after the `exec` subcommand.
    // `codex exec -c model_reasoning_effort=<level> …`.
    thinking: { levels: ["minimal", "low", "medium", "high"], default: "medium", template: ["-c", "model_reasoning_effort={level}"], insertAt: 1 },
    packageName: "@openai/codex",
    promptMode: "argv",
    // Hidden from the picker: the governed `codex-approvals` app-server shim
    // supersedes this plain exec path (still runnable via BIVY_RUNTIME=codex).
    hidden: true,
    install: { kind: "npm", pkg: "@openai/codex" },
  },
  opencode: {
    displayName: "OpenCode",
    command: "opencode",
    packageName: "opencode-ai",
    // `opencode run "<prompt>"` runs one non-interactive turn and streams the
    // reply to stdout (the TUI needs a real TTY and would hang over a pipe).
    args: ["run"],
    promptMode: "argv",
    supportTier: "beta",
    blurb: "The most widely used open-source coding harness (OpenCode CLI).",
    // `opencode run -s <id> "<prompt>"` continues a prior session by its own id
    // (`-s, --session  session id to continue`, per `opencode run --help`).
    resume: { template: ["run", "-s", "{id}"] },
    // `opencode run --model <provider/model> "<prompt>"` — the flag follows the
    // `run` subcommand (insertAt: 1). Models are `provider/model` ids.
    model: {
      flag: "--model",
      insertAt: 1,
      models: [
        { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
        { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
      ],
    },
    // OpenCode ships a native ACP server (`opencode acp`, per opencode.ai/docs/acp),
    // so it can be driven through the governed ProtocolRuntime instead of the pipe —
    // per-tool approvals + streaming + resume. Opt in with BIVY_OPENCODE_ACP=1 (or
    // global BIVY_PREFER_ACP=1); off by default until validated for your version.
    acp: { args: ["acp"] },
    install: { kind: "npm", pkg: "opencode-ai" },
  },
  aider: {
    displayName: "Aider",
    command: "aider",
    packageName: "aider-chat",
    // `aider --message "<prompt>" --yes-always` runs a single non-interactive,
    // git-aware turn and exits instead of dropping into the REPL.
    args: ["--yes-always", "--message"],
    promptMode: "argv",
    supportTier: "beta",
    authOwner: "mixed",
    blurb: "Popular git-native pair-programming agent (Aider).",
    // `aider --model <id> …` — a leading option (insertAt: 0). Aider resolves its
    // own short aliases (sonnet/opus/gpt-4o/…) to concrete provider models.
    model: {
      flag: "--model",
      models: [
        { id: "sonnet", name: "Claude Sonnet (alias)", provider: "anthropic" },
        { id: "opus", name: "Claude Opus (alias)", provider: "anthropic" },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
        { id: "o3", name: "OpenAI o3", provider: "openai" },
        { id: "gemini", name: "Gemini (alias)", provider: "google" },
        { id: "deepseek", name: "DeepSeek (alias)", provider: "deepseek" },
      ],
    },
    // No `resume`: stock aider-chat has no "continue session <id>" flag. Its own
    // continuity is `--restore-chat-history` reading `.aider.chat.history.md`,
    // scoped to the cwd rather than to a Bivy session id — orthogonal to the
    // generic id-based primitive, and unsafe to bolt on generically (a second,
    // unrelated session opened in the same workspace would inherit that file's
    // history). See docs/agents-not-fully-supported.md.
    install: { kind: "pip", pkg: "aider-chat" },
  },
  hermes: {
    displayName: "Hermes",
    command: "hermes",
    // The npm package is `hermes-agent` (ships the `hermes` bin); the bare
    // `hermes` package is an unrelated abandoned segmentio lib.
    packageName: "hermes-agent",
    promptMode: "argv",
    // Hidden from the picker: dumb-pipe adapter with no validated JSON parser or
    // documented session/resume flag (still runnable via BIVY_RUNTIME=hermes).
    hidden: true,
    // No `resume`: no documented session/resume flag.
    install: { kind: "npm", pkg: "hermes-agent" },
  },
  goose: {
    displayName: "Goose",
    command: "goose",
    packageName: "block/goose",
    args: ["run", "-t"],
    // `goose run --output-format stream-json` streams message/complete envelopes.
    jsonArgs: ["run", "--output-format", "stream-json", "-t"],
    parserId: "goose-stream-json",
    // Goose has no CLI sandbox flag; governed by the FS/MCP/network channels.
    composeArgs: ({ structured }) => (structured ? ["run", "--output-format", "stream-json", "-t"] : ["run", "-t"]),
    // `goose run --resume --session-id <id> -t "<prompt>"` continues a prior
    // session by id (`--session-id` "Requires --resume", per `goose run --help`).
    resume: { template: ["run", "--output-format", "stream-json", "--resume", "--session-id", "{id}", "-t"] },
    // Goose exposes a native ACP server (`goose acp`, per the Goose "ACP clients"
    // guide), so it can be driven through the governed ProtocolRuntime instead of the
    // stream-json pipe — per-tool approvals + streaming + resume. Opt in with
    // BIVY_GOOSE_ACP=1 (or global BIVY_PREFER_ACP=1); off by default until validated.
    acp: { args: ["acp"] },
    promptMode: "argv",
    supportTier: "beta",
    blurb: "Block's open-source agent with a structured stream-json protocol (Goose).",
    // Homebrew isn't present on stock Linux nodes (brew → ENOENT); the official
    // download script installs the goose binary on both Linux and macOS.
    // `brew install block/tap/goose` ENOENTs on any node without Homebrew; the
    // official download script installs the binary into `{bin}` (on PATH) on both
    // Linux and macOS. `{bin}` expands to `<prefix>/bin` at install time.
    install: {
      kind: "curl",
      display: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
      shell: 'mkdir -p "{bin}" && curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false GOOSE_BIN_DIR="{bin}" bash',
    },
  },
  gemini: {
    displayName: "Gemini CLI",
    command: "gemini",
    packageName: "@google/gemini-cli",
    supportTier: "beta",
    blurb: "Google's terminal coding agent (Gemini CLI).",
    // `gemini -m <id> … -p "<prompt>"` — a leading option before the trailing `-p`
    // (insertAt: 0). The prompt flag stays last, so prepending is safe.
    model: {
      flag: "-m",
      models: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
      ],
    },
    args: ["-p"],
    // `gemini -o json` returns one final {session_id,response,stats,error} object.
    jsonArgs: ["-o", "json", "-p"],
    parserId: "gemini-json",
    // Gemini contains via --approval-mode; -p must stay last so the prompt
    // (appended by ProcessRuntime) lands as its value.
    composeArgs: ({ structured, tier }) => [...(structured ? ["-o", "json"] : []), ...sandboxArgsFor("gemini", tier), "-p"],
    // `gemini -o json --approval-mode <mode> -r <id> -p "<prompt>"` continues a
    // previous session (`-r, --resume  Resume a previous session. Use "latest" for
    // most recent or index number (e.g. --resume 5)`, per `gemini --help`; a
    // session UUID also works). `{sandbox}` re-derives --approval-mode from the
    // tier so a resumed turn stays as contained as a fresh one.
    resume: { template: ["-o", "json", "{sandbox}", "-r", "{id}", "-p"] },
    // Gemini CLI speaks ACP (`--experimental-acp`), so it can be driven through the
    // governed ProtocolRuntime instead of the one-shot pipe — per-tool approvals +
    // streaming + resume. Opt in with BIVY_GEMINI_ACP=1 (or global BIVY_PREFER_ACP=1);
    // off by default until validated for your Gemini version.
    acp: { args: ["--experimental-acp"] },
    promptMode: "argv",
    install: { kind: "npm", pkg: "@google/gemini-cli" },
  },
  qwen: {
    displayName: "Qwen Code",
    command: "qwen",
    packageName: "@qwen-code/qwen-code",
    supportTier: "beta",
    blurb: "Alibaba's Qwen Code CLI (a Gemini-CLI fork tuned for Qwen-Coder models).",
    // Gemini-CLI fork: same `-m <id> … -p` model flag (insertAt: 0).
    model: {
      flag: "-m",
      models: [
        { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", provider: "qwen" },
        { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", provider: "qwen" },
      ],
    },
    // Qwen Code is a Gemini-CLI fork: `-p` runs headless and `--output-format json`
    // emits the same {response,stats,error} envelope Gemini does, so it reuses the
    // gemini-json parser. (Per the Qwen Code headless docs.)
    args: ["-p"],
    jsonArgs: ["--output-format", "json", "-p"],
    parserId: "gemini-json",
    // Shares Gemini's `--approval-mode` containment (see sandboxArgsFor("qwen")).
    composeArgs: ({ structured, tier }) => [...(structured ? ["--output-format", "json"] : []), ...sandboxArgsFor("qwen", tier), "-p"],
    // Gemini-CLI fork: same `--resume <id>` headless resume form (Qwen Code docs,
    // "Headless Mode"). `{sandbox}` re-derives --approval-mode from the tier.
    resume: { template: ["--output-format", "json", "{sandbox}", "--resume", "{id}", "-p"] },
    // Qwen Code inherits Gemini CLI's ACP server (packages/cli/src/acp-integration),
    // so it can be driven through the governed ProtocolRuntime instead of the pipe —
    // per-tool approvals + streaming + resume. Newer builds graduated the flag to
    // `--acp`, but `--experimental-acp` remains a backward-compatible alias across
    // versions (deprecation warning goes to stderr, which the shim logs separately,
    // so it can't corrupt the JSON-RPC stream). Opt in with BIVY_QWEN_ACP=1 (or
    // global BIVY_PREFER_ACP=1); off by default until validated for your version.
    // Zed's ACP registry lists qwen-code with `args: ["--acp"]`.
    acp: { args: ["--experimental-acp"] },
    promptMode: "argv",
    install: { kind: "npm", pkg: "@qwen-code/qwen-code" },
  },
  cline: {
    displayName: "Cline",
    command: "cline",
    packageName: "cline",
    supportTier: "beta",
    blurb: "Cline's standalone terminal agent (the CLI sibling of the Cline IDE extension).",
    // `cline -y "<prompt>"` runs one autonomous, non-interactive task (‑y/‑‑yolo
    // skips per-tool prompts so a piped run doesn't wedge on approval). Bivy's
    // sandbox tier still bounds real effects. Flags are best-effort against the
    // Cline CLI docs — override with BIVY_CLINE_ARGS if a version differs.
    args: ["-y"],
    // `cline --id <id> "<prompt>" -y` resumes an existing session by id
    // (`--id <session-id>` "Resume an existing session by ID", per the Cline CLI
    // reference). No native sandbox/approval-mode flag, so no `{sandbox}` here.
    resume: { template: ["--id", "{id}", "-y"] },
    // The Cline CLI (>2.0.0) speaks ACP via `cline --acp` (per docs.cline.bot ACP
    // editor integrations), so it can be driven through the governed ProtocolRuntime
    // instead of the `-y` pipe — per-tool approvals + streaming + resume. Opt in with
    // BIVY_CLINE_ACP=1 (or global BIVY_PREFER_ACP=1); off by default until validated.
    acp: { args: ["--acp"] },
    promptMode: "argv",
    install: { kind: "npm", pkg: "cline" },
  },
  crush: {
    displayName: "Crush",
    command: "crush",
    packageName: "@charmland/crush",
    supportTier: "beta",
    blurb: "Charm's glamourous open-source coding agent (Crush).",
    // `crush run "<prompt>"` runs a single non-interactive prompt and exits;
    // `-q/--quiet` suppresses the spinner UI so stdout is just the reply.
    // Override with BIVY_CRUSH_ARGS if a version differs.
    args: ["run", "-q"],
    // No `resume`: `crush run` has no session/continue flag upstream yet
    // (charmbracelet/crush#1982, #1015 track adding one) — see
    // docs/agents-not-fully-supported.md.
    promptMode: "argv",
    install: { kind: "npm", pkg: "@charmland/crush" },
  },

  // ---- Second wave (the next-most-used coding-agent CLIs) --------------------
  // Each is pure data on the shared ProcessRuntime path — the same "add an agent
  // = add a spec, not code" mechanism as the block above. Launch/resume/model
  // flags are validated against each CLI's current docs; every one is overridable
  // per node with BIVY_<ID>_ARGS / _RESUME_TEMPLATE / _MODELS.
  cursor: {
    displayName: "Cursor",
    command: "cursor-agent",
    packageName: "cursor (curl https://cursor.com/install)",
    supportTier: "beta",
    blurb: "Cursor's standalone terminal coding agent (cursor-agent) — the editor's engine on the CLI.",
    // `cursor-agent --force -p "<prompt>"` runs one non-interactive print turn and
    // exits (`-p/--print`); `--force` auto-approves tool/command execution so a
    // piped run never blocks on approvals. Prompt is the trailing positional arg.
    args: ["--force", "-p"],
    // Cursor's `--output-format stream-json` emits a streaming JSON event log; the
    // tolerant generic parser reads it. Opt-in (unverified schema) — see below.
    jsonArgs: ["--output-format", "stream-json", "--force", "-p"],
    parserId: "generic-stream-json",
    parserUnverified: true,
    // `cursor-agent --resume=<chatId> …` continues a prior chat by its own id.
    resume: { template: ["--force", "--resume={id}", "-p"] },
    // `cursor-agent -m <id> …` — a leading option (insertAt: 0).
    model: {
      flag: "-m",
      models: [
        { id: "sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "opus-4.1", name: "Claude Opus 4.1", provider: "anthropic" },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
      ],
    },
    // Cursor's agent speaks ACP (`cursor-agent acp`, per cursor.com/docs/cli/acp),
    // so it can be driven through the governed ProtocolRuntime instead of the
    // `--force -p` pipe — per-tool approvals + streaming + resume. Opt in with
    // BIVY_CURSOR_ACP=1 (or global BIVY_PREFER_ACP=1); off by default until validated.
    acp: { args: ["acp"] },
    promptMode: "argv",
    // Not on npm — Cursor ships a curl installer that drops `cursor-agent` on PATH.
    install: { kind: "curl", display: "curl https://cursor.com/install -fsS | bash", shell: "curl https://cursor.com/install -fsS | bash" },
  },
  copilot: {
    displayName: "GitHub Copilot",
    command: "copilot",
    packageName: "@github/copilot",
    supportTier: "beta",
    blurb: "GitHub's official terminal coding agent (Copilot CLI).",
    // `copilot --allow-all-tools -p "<prompt>"` runs one programmatic turn and
    // exits; --allow-all-tools skips per-tool approval so a piped run doesn't
    // wedge. `-p/--prompt` takes the prompt as its value (kept last so the
    // trailing prompt lands there).
    args: ["--allow-all-tools", "-p"],
    // `copilot --model <id> …`
    model: {
      flag: "--model",
      models: [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
      ],
    },
    // No `resume`: Copilot's resume flag isn't pinned to a stable by-id form yet;
    // wire one with BIVY_COPILOT_RESUME_TEMPLATE if your version documents it.
    // Copilot CLI ships an ACP server (`copilot --acp`; public preview Jan 2026, per
    // docs.github.com Copilot CLI reference), so it can be driven through the governed
    // ProtocolRuntime instead of the `--allow-all-tools -p` pipe — per-tool approvals
    // + streaming + resume (ACP `session/load` covers the resume the pipe lacks). Opt
    // in with BIVY_COPILOT_ACP=1 (or global BIVY_PREFER_ACP=1); off by default until
    // validated for your version.
    acp: { args: ["--acp"] },
    promptMode: "argv",
    install: { kind: "npm", pkg: "@github/copilot" },
  },
  grok: {
    displayName: "Grok",
    command: "grok",
    packageName: "@vibe-kit/grok-cli",
    supportTier: "beta",
    blurb: "Open-source terminal agent for xAI's Grok models (Grok CLI).",
    // `grok -p "<prompt>"` runs one prompt and exits (headless); `-m <id>` picks
    // the model. (The widely-installed @vibe-kit/grok-cli has no by-id resume or
    // JSON flag; the superagent `grok-dev` fork does — override via env if you run
    // that one.)
    args: ["-p"],
    model: {
      flag: "-m",
      models: [
        { id: "grok-code-fast-1", name: "Grok Code Fast 1", provider: "xai" },
        { id: "grok-4-latest", name: "Grok 4", provider: "xai" },
        { id: "grok-3-fast", name: "Grok 3 Fast", provider: "xai" },
      ],
    },
    promptMode: "argv",
    install: { kind: "npm", pkg: "@vibe-kit/grok-cli" },
  },
  amp: {
    displayName: "Amp",
    command: "amp",
    packageName: "@sourcegraph/amp",
    supportTier: "beta",
    blurb: "Sourcegraph's autonomous coding agent with persistent threads (Amp).",
    // `amp -x "<prompt>"` (`--execute`) runs one thread turn and streams to stdout;
    // Amp doesn't gate tools per-run (governed by its own allowlist config), so no
    // approval flag is needed. Prompt trails `-x`.
    args: ["-x"],
    // Amp's `--stream-json` emits one JSON object per line; the tolerant generic
    // parser reads it. Opt-in (unverified schema) — see parserUnverified below.
    jsonArgs: ["--stream-json", "-x"],
    parserId: "generic-stream-json",
    parserUnverified: true,
    // `amp threads continue <id> -x "<prompt>"` continues a prior thread by id.
    resume: { template: ["threads", "continue", "{id}", "-x"] },
    // No model flag: Amp manages model selection itself (agent "mode"), so we don't
    // advertise a picker it can't drive.
    promptMode: "argv",
    install: { kind: "npm", pkg: "@sourcegraph/amp" },
  },
  auggie: {
    displayName: "Auggie",
    command: "auggie",
    packageName: "@augmentcode/auggie",
    supportTier: "beta",
    blurb: "Augment Code's terminal agent backed by its codebase context engine (Auggie).",
    // `auggie --quiet --print "<prompt>"` runs one non-interactive turn and prints
    // the final reply (`--print`); `--quiet` drops the UI chatter. Prompt trails.
    args: ["--quiet", "--print"],
    // No pinned by-id resume or model flag upstream (Augment manages the model);
    // override via BIVY_AUGGIE_RESUME_TEMPLATE / _MODELS if your version adds them.
    promptMode: "argv",
    install: { kind: "npm", pkg: "@augmentcode/auggie" },
  },
  droid: {
    displayName: "Droid",
    command: "droid",
    packageName: "droid (curl https://app.factory.ai/cli)",
    supportTier: "beta",
    blurb: "Factory AI's autonomous terminal coding agent (Droid).",
    // `droid exec --auto high "<prompt>"` runs one headless task at high autonomy
    // (auto-approves) and streams to stdout. Prompt trails the `exec` subcommand.
    args: ["exec", "--auto", "high"],
    // `droid exec --output-format json` prints a final JSON object; the tolerant
    // generic parser reads it. Opt-in (unverified schema) — see below.
    jsonArgs: ["exec", "--output-format", "json", "--auto", "high"],
    parserId: "generic-json",
    parserUnverified: true,
    // `droid exec --model <id> …` — after the `exec` subcommand (insertAt: 1).
    model: {
      flag: "--model",
      insertAt: 1,
      models: [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "claude-opus-4.1", name: "Claude Opus 4.1", provider: "anthropic" },
        { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "openai" },
      ],
    },
    promptMode: "argv",
    // Not on npm — Factory ships a curl installer that drops `droid` on PATH.
    install: { kind: "curl", display: "curl -fsSL https://app.factory.ai/cli | sh", shell: "curl -fsSL https://app.factory.ai/cli | sh" },
  },
  continue: {
    displayName: "Continue",
    command: "cn",
    packageName: "@continuedev/cli",
    supportTier: "beta",
    blurb: "Continue's headless terminal agent (cn) driving configurable assistants.",
    // `cn --auto -p "<prompt>"` runs one headless turn (`-p` = no TUI) and prints
    // the final response; `--auto` allows all tools without prompting. Prompt
    // trails `-p`.
    args: ["--auto", "-p"],
    // `cn -p … --format json` prints a final JSON object; the tolerant generic
    // parser reads it. Opt-in (unverified schema) — see below.
    jsonArgs: ["--auto", "--format", "json", "-p"],
    parserId: "generic-json",
    parserUnverified: true,
    // `cn --model <slug> …` — Continue Hub owner/model slugs (insertAt: 0).
    model: {
      flag: "--model",
      models: [
        { id: "anthropic/claude-4-sonnet", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
      ],
    },
    // No `resume`: `cn --resume` continues only the last session for the current
    // terminal — there's no resume-by-id form to plug into the generic primitive.
    promptMode: "argv",
    install: { kind: "npm", pkg: "@continuedev/cli" },
  },
  kilocode: {
    displayName: "Kilo Code",
    command: "kilo",
    packageName: "@kilocode/cli",
    supportTier: "beta",
    blurb: "Kilo Code's terminal CLI (an OpenCode fork) for pipeline-friendly agentic coding.",
    // `kilo run --auto "<prompt>"` runs one non-interactive turn (`run`) with
    // auto-approved permissions (`--auto`) and streams to stdout. Prompt trails.
    args: ["run", "--auto"],
    // `kilo run --format json` emits raw JSON events; the tolerant generic parser
    // reads them. Opt-in (unverified schema) — see below.
    jsonArgs: ["run", "--format", "json", "--auto"],
    parserId: "generic-stream-json",
    parserUnverified: true,
    // `kilo run -s <id> --auto "<prompt>"` continues a session by id.
    resume: { template: ["run", "-s", "{id}", "--auto"] },
    // Kilo Code exposes a native ACP server (`kilo acp`, per the Kilo CLI docs —
    // mirroring OpenCode's design, its upstream). Driven through the governed
    // ProtocolRuntime instead of the `run --auto` pipe, it gains per-tool approvals +
    // streaming + resume. Opt in with BIVY_KILOCODE_ACP=1 (or global BIVY_PREFER_ACP=1);
    // off by default until validated for your version.
    acp: { args: ["acp"] },
    // `kilo run -m <provider/model> …` — after the `run` subcommand (insertAt: 1).
    model: {
      flag: "-m",
      insertAt: 1,
      models: [
        { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
      ],
    },
    promptMode: "argv",
    install: { kind: "npm", pkg: "@kilocode/cli" },
  },
  rovodev: {
    displayName: "Rovo Dev",
    command: "acli",
    packageName: "atlassian acli (rovodev)",
    supportTier: "beta",
    blurb: "Atlassian's Rovo Dev terminal coding agent, run through the acli CLI.",
    // `acli rovodev run --yolo "<prompt>"` runs one instruction headlessly; --yolo
    // skips tool-approval prompts. Prompt trails the `rovodev run` subcommand.
    args: ["rovodev", "run", "--yolo"],
    // `acli rovodev run --yolo --restore <id> "<prompt>"` restores a prior session.
    resume: { template: ["rovodev", "run", "--yolo", "--restore", "{id}"] },
    // No `--model` CLI flag (Atlassian-managed; models switch via the in-session
    // /models command), so we don't advertise a picker it can't drive.
    promptMode: "argv",
    // Ships as part of the Atlassian CLI, not npm — installed out of band.
  },
  codebuff: {
    displayName: "Codebuff",
    command: "codebuff",
    packageName: "codebuff",
    // Hidden from the picker (see PICKER_RUNTIME_IDS). The `codebuff` binary has no
    // verified non-TTY headless / print-and-exit mode upstream — its trailing-arg
    // `codebuff "<prompt>"` seeds the interactive TUI, and true automation is meant
    // to go through @codebuff/sdk. We keep the spec so it's runnable via
    // BIVY_RUNTIME=codebuff and promotable to the picker (data-only) the moment a
    // headless flag ships; until then it stays out of the picker to keep it honest.
    supportTier: "experimental",
    blurb: "Open-source multi-agent terminal coding assistant (Codebuff). Headless automation is via @codebuff/sdk today.",
    hidden: true,
    args: [],
    // `codebuff --continue <id> "<prompt>"` continues a prior conversation by id.
    resume: { template: ["--continue", "{id}"] },
    promptMode: "argv",
    install: { kind: "npm", pkg: "codebuff" },
  },
};

export function isCliAgentId(id: string): id is CliAgentId {
  return Object.prototype.hasOwnProperty.call(CLI_AGENT_SPECS, id);
}

/** Ordered CLI agent ids (spec insertion order) — the manifest's canonical order. */
export const CLI_AGENT_IDS = Object.keys(CLI_AGENT_SPECS) as CliAgentId[];

/**
 * The install command for a CLI agent, derived from its structured `install`
 * descriptor — the SINGLE source of truth shared by the catalog "Install" button,
 * the server auto-install endpoint, and the terminal CLI manifest. Returns the
 * executable form (`command`/`args`) plus the human `display` string, or undefined
 * when the agent installs out of band (no `install`).
 *
 * `prefix` is the node's npm/bin prefix (BIVY_NPM_GLOBAL_PREFIX, default ~/.local).
 * `{bin}` in a curl `shell` expands to `<prefix>/bin`.
 */
export function cliInstallSpec(id: CliAgentId, prefix: string): { command: string; args: string[]; display: string } | undefined {
  const install = CLI_AGENT_SPECS[id].install;
  if (!install) return undefined;
  if (install.kind === "npm") {
    return {
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, install.pkg],
      display: `npm install --global --prefix ${prefix} ${install.pkg}`,
    };
  }
  if (install.kind === "pip") {
    // Some node images ship a python3 without pip; bootstrap it via ensurepip
    // (best-effort) before installing, but show users the plain pip line.
    return {
      command: "sh",
      args: ["-c", `python3 -m ensurepip --user >/dev/null 2>&1 || true; python3 -m pip install --user ${install.pkg}`],
      display: `python3 -m pip install --user ${install.pkg}`,
    };
  }
  // curl / script: `{bin}` → the node's <prefix>/bin so binaries land on PATH.
  const shell = install.shell.replace(/\{bin\}/g, `${prefix}/bin`);
  return { command: "sh", args: ["-c", shell], display: install.display };
}

/**
 * Serializable agent manifest — the identity/install/visibility subset of
 * CLI_AGENT_SPECS with no functions, so it can be written to
 * `bin/agent-manifest.json` and consumed by the plain-JS terminal CLI
 * (`bin/bivy.mjs`) that can't import this TypeScript module. `scripts/
 * generate-agent-manifest.mjs` regenerates the JSON; a unit test asserts the file
 * is in sync so the two never drift.
 */
export function cliAgentManifest(): Array<{
  id: CliAgentId;
  label: string;
  command: string;
  hidden: boolean;
  headlessFlags: string[];
  install: CliInstall | null;
}> {
  return CLI_AGENT_IDS.map((id) => {
    const spec = CLI_AGENT_SPECS[id];
    // The tokens that mean "one-shot / headless" for `bivy run <agent> …` — the
    // spec's own launch args plus its resume subcommand, deduped. This lets the
    // terminal detect a human running a one-shot without a hand-maintained list.
    const headless = new Set<string>();
    for (const a of spec.args ?? []) if (a.startsWith("-") || /^[a-z]/.test(a)) headless.add(a);
    if (spec.resume) for (const a of spec.resume.template) if (a.startsWith("-") || /^[a-z]/.test(a)) headless.add(a);
    return {
      id,
      label: spec.displayName,
      command: spec.command,
      hidden: Boolean(spec.hidden),
      headlessFlags: [...headless].filter((a) => !a.includes("{")),
      install: spec.install ?? null,
    };
  });
}

/**
 * Per-agent launch-arg override, e.g. `BIVY_CLINE_ARGS='["task","--json"]'`. Lets
 * an operator correct a CLI's flags for a version we haven't pinned without a code
 * change (the beta CLI agents ship best-effort defaults). Malformed = ignored.
 */
function cliArgsOverride(id: CliAgentId): string[] | undefined {
  const raw = process.env[`BIVY_${id.toUpperCase()}_ARGS`]?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through — ignore a malformed override
  }
  return undefined;
}

/**
 * Resolve a CLI agent's resume template: an operator override
 * (`BIVY_<ID>_RESUME_TEMPLATE`, a JSON arg array with `{id}`/`{tier}`) wins, else
 * the spec's built-in template. Returns undefined when the agent has no known
 * resume form — which keeps the catalog honest (resume reported off).
 */
function cliResumeTemplate(id: CliAgentId): string[] | undefined {
  const raw = process.env[`BIVY_${id.toUpperCase()}_RESUME_TEMPLATE`]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to the spec default
    }
  }
  return CLI_AGENT_SPECS[id].resume?.template;
}

/**
 * Resolve a CLI agent's selectable model list: `BIVY_<ID>_MODELS` (a JSON array of
 * `{id,name?,provider?}`) overrides the spec's curated defaults. Each entry is
 * normalized to a full ModelInfo (the id is the CLI's own model name). Returns an
 * empty list when the agent has no model config and no override.
 */
function cliModelList(id: CliAgentId): ModelInfo[] {
  const spec = CLI_AGENT_SPECS[id];
  let entries = spec.model?.models;
  const raw = process.env[`BIVY_${id.toUpperCase()}_MODELS`]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const out: Array<{ id: string; name?: string; provider?: string }> = [];
        for (const item of parsed) {
          const e = (item && typeof item === "object" ? item : { id: item }) as Record<string, unknown>;
          const modelId = typeof e.id === "string" ? e.id.trim() : "";
          if (!modelId) continue;
          out.push({
            id: modelId,
            name: typeof e.name === "string" ? e.name : undefined,
            provider: typeof e.provider === "string" ? e.provider : undefined,
          });
        }
        entries = out;
      }
    } catch {
      // fall through to the spec defaults
    }
  }
  return (entries ?? []).map((e) => ({ provider: e.provider ?? id, id: e.id, name: e.name ?? e.id }));
}

/**
 * Build the ProcessRuntime model config for a CLI agent, or undefined when the
 * agent has no model flag or an empty list (so the runtime honestly reports
 * modelSelection off). The chosen model id is passed as the value of `spec.model.flag`.
 */
function cliModelConfig(id: CliAgentId): ProcessModelConfig | undefined {
  const spec = CLI_AGENT_SPECS[id];
  if (!spec.model) return undefined;
  const models = cliModelList(id);
  if (!models.length) return undefined;
  return {
    models,
    modelArgs: (modelId: string) => [spec.model!.flag, modelId],
    insertAt: spec.model.insertAt,
  };
}

// Structured parsers that extract token usage from the agent's output (so the
// runtime can honestly advertise usageReporting — see cli-parsers.extractTokenUsage).
const USAGE_PARSERS = new Set(["codex-json", "gemini-json", "goose-stream-json"]);

/** Whether a CLI agent runs a usage-emitting structured parser this launch. */
function cliUsageReporting(id: CliAgentId): boolean {
  const parserId = process.env.BIVY_AGENT_PARSER || CLI_AGENT_SPECS[id].parserId;
  return Boolean(parserId) && USAGE_PARSERS.has(parserId!) && process.env.BIVY_AGENT_STRUCTURED !== "0";
}

/**
 * Build the ProcessRuntime thinking config for a CLI agent, or undefined when it
 * has no reasoning-effort flag. `BIVY_<ID>_THINKING` (JSON
 * `{levels,template,insertAt?,default?}`) overrides/enables it for any agent.
 */
function cliThinkingConfig(id: CliAgentId): ProcessThinkingConfig | undefined {
  let cfg = CLI_AGENT_SPECS[id].thinking;
  const raw = process.env[`BIVY_${id.toUpperCase()}_THINKING`]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.levels) && Array.isArray(parsed.template)) {
        cfg = { levels: parsed.levels.map(String), template: parsed.template.map(String), insertAt: typeof parsed.insertAt === "number" ? parsed.insertAt : undefined, default: parsed.default ? String(parsed.default) : undefined };
      }
    } catch {
      // fall through to the spec default
    }
  }
  if (!cfg || !cfg.levels.length) return undefined;
  const template = cfg.template;
  return {
    levels: cfg.levels,
    default: cfg.default,
    thinkingArgs: (level: string) => template.map((a) => a.replace(/\{level\}/g, level)),
    insertAt: cfg.insertAt,
  };
}

// --- #4: opt-in capability probing (self-healing honesty) -------------------
// Our advertised resume/model capabilities are pinned against each CLI's docs at a
// point in time, so a version that renamed or dropped a flag would keep rendering a
// control that silently no-ops. `BIVY_AGENT_PROBE=1` turns on a preflight that runs
// `<cli> --help` once (cached) and DOWNGRADES any capability whose flag the
// installed binary doesn't actually mention. It never UPGRADES — adding a
// capability needs the exact arg template, which help text can't safely supply — so
// probing can only make the catalog MORE honest, never invent a no-op control.
const HELP_PROBE_CACHE = new Map<string, string | null>();
function probeHelpText(command: string): string | null {
  if (HELP_PROBE_CACHE.has(command)) return HELP_PROBE_CACHE.get(command) ?? null;
  let text: string | null = null;
  try {
    const res = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 4000 });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    text = out.length > 20 ? out.toLowerCase() : null; // too-short output = not real help
  } catch {
    text = null;
  }
  HELP_PROBE_CACHE.set(command, text);
  return text;
}

// A resume template mixes launch flags (`-p`, `--force`) with the resume-specific
// token(s) (`--resume`, `threads continue`, `-s`, `--restore`, …). Only the latter
// evidence resume support, so we match on those — otherwise a shared launch flag
// appearing in help would mask a genuinely-missing resume flag.
const RESUME_HINT = /resume|continue|restore|session|thread|^-s$|^-r$|^-c$|^--id$/i;
/** The resume-indicative flag/subcommand tokens of a resume template. */
function resumeTokensFor(id: CliAgentId): string[] {
  const tmpl = cliResumeTemplate(id) ?? [];
  return tmpl
    .map((t) => t.replace(/=\{[a-z]+\}/g, "").replace(/\{[a-z]+\}/g, "").trim())
    .filter((t) => t && !t.startsWith("{") && RESUME_HINT.test(t));
}

/**
 * Pure refinement: given an installed CLI's `--help` text, drop any capability the
 * binary doesn't evidence. Exported for direct unit testing. `resumeTokens` are the
 * resume form's flag/subcommand words (e.g. `["--resume"]`, `["threads","continue"]`);
 * if NONE appear in help, resume is downgraded. Likewise the model flag.
 */
export function refineCapabilitiesFromHelp(
  help: string,
  current: { resume: boolean; modelSelection: boolean },
  spec: { resumeTokens: string[]; modelFlag?: string },
): { resume: boolean; modelSelection: boolean } {
  const h = help.toLowerCase();
  let { resume, modelSelection } = current;
  if (resume && spec.resumeTokens.length && !spec.resumeTokens.some((t) => h.includes(t.toLowerCase()))) {
    resume = false;
  }
  if (modelSelection && spec.modelFlag && !h.includes(spec.modelFlag.toLowerCase())) {
    modelSelection = false;
  }
  return { resume, modelSelection };
}

function cliAgentInfo(id: CliAgentId): RuntimeInfo {
  const spec = CLI_AGENT_SPECS[id];
  const installed = commandAvailable(spec.command);
  const npmPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || "~/.local";
  const installCommand = cliInstallSpec(id, npmPrefix);
  // Honesty invariant (see docs/agents-not-fully-supported.md): capabilities must
  // reflect what the ProcessRuntime path actually delivers, or the PWA renders a
  // picker that silently no-ops. These CLI adapters stream stdout (structured via
  // a CliParser when the agent has a validated JSON mode, else raw) and are
  // governed at the effect level (sandbox tier / FS-MCP-network channels), so
  // toolInterception + modelSelection stay false. resume is on only when the
  // agent has a known resume form (spec.resume or a BIVY_<ID>_RESUME_TEMPLATE
  // override) — Codex is the built-in example; the rest are fresh-process-per-
  // prompt until a resume template is wired.
  let resume = id === "codex" || Boolean(cliResumeTemplate(id));
  let modelSelection = Boolean(cliModelConfig(id));
  const usageReporting = cliUsageReporting(id);
  // When the agent is promoted to ACP (spec.acp + BIVY_<ID>_ACP / BIVY_PREFER_ACP),
  // it runs through the governed ProtocolRuntime — so it honestly gains per-tool
  // approvals and resume. Reflect that in the catalog the picker reads.
  const acpActive = prefersAcp(id);
  if (acpActive) resume = true;
  // Opt-in self-healing: if the installed binary's --help doesn't evidence a
  // resume/model flag we advertise, downgrade it (never upgrade). Codex keeps its
  // native, separately-verified resume path, so it's exempt.
  if (process.env.BIVY_AGENT_PROBE === "1" && installed && id !== "codex") {
    const help = probeHelpText(spec.command);
    if (help) {
      const refined = refineCapabilitiesFromHelp(help, { resume, modelSelection }, { resumeTokens: resumeTokensFor(id), modelFlag: spec.model?.flag });
      resume = refined.resume;
      modelSelection = refined.modelSelection;
    }
  }
  return {
    id,
    displayName: spec.displayName,
    description: spec.blurb ?? `Run the local ${spec.displayName} CLI underneath Bivy in the session workspace.`,
    status: installed ? "available" : "external",
    packageName: spec.packageName,
    language: "Process",
    // MCP tool calls are gated by real approvals when the proxy shim is enabled
    // (BIVY_MCP_PROXY) — an honest, narrower capability than full toolInterception
    // (it governs MCP tools, not the agent's built-in shell/edits). See
    // src/harness/mcp-inject.ts + governMcpCall in src/server.ts.
    capabilities: { toolInterception: acpActive, mcpToolApprovals: acpActive || Boolean(process.env.BIVY_MCP_PROXY), modelSelection, resume, packages: false, fork: false, usageReporting, sessionDiscovery: id === "codex" },
    supportTier: spec.supportTier ?? (id === "codex" ? "supported" : "experimental"),
    authOwner: spec.authOwner ?? "agent",
    notes: installed
      ? `Available on PATH. This process adapter ${spec.parserId && !spec.parserUnverified ? "parses its native JSON stream into a structured transcript" : spec.parserId ? "streams stdout/stderr (a structured JSON parser is available; opt in with BIVY_AGENT_STRUCTURED=1 once validated for your version)" : "streams stdout/stderr"}; Bivy governs its filesystem/exec/MCP effects at the sandbox tier rather than intercepting each tool call. Override its launch flags with BIVY_${id.toUpperCase()}_ARGS if your CLI version differs.`
      : `${spec.command} was not found on PATH. Install it on this node, then select this agent again.`,
    install: installed || !installCommand ? undefined : {
      label: `Install ${spec.displayName}`,
      description: `Install ${spec.displayName} on this node now (${installCommand.display}).`,
      command: installCommand.display,
    },
  };
}

// "Codex" — the app-server shim runtime (id `codex-approvals`). This is the single
// Codex we surface: same binary as the plain exec runtime, but driven through the
// app-server shim so each shell command / file change gets a pre-execution
// Approve/Deny card via guardianInterceptor, AND it resumes a prior thread by its
// rollout id (thread/resume). Governed + resumable in one runtime supersedes the
// exec path, which stays runnable via `BIVY_RUNTIME=codex` for a no-approval flow.
function codexApprovalsInfo(): RuntimeInfo {
  const installed = commandAvailable("codex");
  return {
    id: "codex-approvals",
    displayName: "Codex",
    description: "Codex driven through its app-server: every shell command or file change it proposes is gated through Bivy's Approve/Deny before it runs (not just the exec jail), and sessions resume with full history.",
    status: installed ? "available" : "external",
    packageName: "codex",
    language: "Process",
    capabilities: {
      toolInterception: true,
      modelSelection: true,
      resume: true,
      packages: false,
      fork: false,
      sessionDiscovery: true,
      // The governed/resumable Codex variant is the one that owns native
      // discovery+adoption (issue #156) — not the plain exec runtime below —
      // so an adopted session gets per-tool approvals from the moment it's
      // imported rather than the ungoverned exec jail.
      nativeSessionDiscovery: true,
      nativeSessionAdoption: true,
    },
    supportTier: "beta",
    authOwner: "agent",
    notes: installed
      ? "Drives Codex's experimental app-server so tool calls surface as in-chat approval cards, and resumes a prior thread by its rollout id (thread/resume). Governance AND resume in one runtime."
      : "codex was not found on PATH. Install it on this node, then select this agent again.",
  };
}

async function suggestCodexSessionName(firstPrompt: string, context: { cwd: string; model?: string }): Promise<string | undefined> {
  const prompt = firstPrompt.trim();
  if (!prompt) return undefined;
  const instruction = [
    "Name this coding-agent session from the user request below.",
    "Return only a concise title of 2-6 words, with no quotes, punctuation, prefix, or explanation.",
    "",
    prompt.slice(0, 4000),
  ].join("\n");
  return new Promise((resolve) => {
    const args = ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];
    if (context.model) args.push("--model", context.model);
    args.push(instruction);
    const child = spawn(process.env.BIVY_CODEX_BIN || "codex", args, { cwd: context.cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(undefined); }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(undefined); return; }
      let text = "";
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
          if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) text = event.item.text;
        } catch { /* ignore non-JSON output */ }
      }
      const clean = text.replace(/[\r\n'"`]/g, " ").replace(/\p{Control}/gu, "").replace(/\s+/g, " ").trim().replace(/[.?!,:;–—-]+$/g, "").slice(0, 60).trim();
      resolve(clean || undefined);
    });
  });
}

// Build the Tier-2 Codex runtime: a ProtocolRuntime driving the app-server shim,
// with the concrete agent id so takeover/discovery/UI treat it as its own
// selectable Codex variant. Capabilities are seeded (toolInterception up front)
// because the daemon decides whether to attach guardianInterceptor from
// runtime.capabilities before the shim's hello handshake lands.
/**
 * Catalog-capable runtimes for the unified model catalog — Pi included as one
 * contributor among equals, not a privileged base. Each runtime's `listCatalog()`
 * contributes its providers + models, deduped and stamped with the shared vault's
 * auth status by `aggregateModelCatalog`. Construction is cheap (no session
 * spawned); listCatalog() is static. Codex is always listed; Claude Code when its
 * SDK is installed.
 */
export function catalogRuntimes(credsDir: string, piDir: string, sessionsDir: string): AgentRuntime[] {
  const runtimes: AgentRuntime[] = [
    new PiRuntime({ credsDir, piDir, sessionsDir }),
    codexAppServerRuntime(credsDir),
  ];
  if (claudeSdkInstalled()) runtimes.push(new ClaudeCodeRuntime(claudeRuntimeFromEnv()));
  return runtimes;
}

// `tier` threads the session's chosen sandbox into the app-server shim as env it
// reads at launch (BIVY_CODEX_SANDBOX / BIVY_CODEX_APPROVAL_POLICY), so the
// governed Codex runtime is contained at the selected tier — including "full
// access" actually disabling the sandbox — instead of the shim's hardcoded
// workspace-write default. Absent (the session-less catalog build) leaves the
// shim on its own defaults.
function codexAppServerRuntime(credsDir: string, tier?: SandboxTier): AgentRuntime {
  const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "codex-app-server-shim.mjs");
  const policy = tier ? codexSandboxPolicy(tier) : undefined;
  return new ProtocolRuntime({
    id: "codex-approvals",
    displayName: "Codex",
    command: process.execPath,
    args: [shim],
    ...(policy ? { env: { BIVY_CODEX_SANDBOX: policy.sandbox, BIVY_CODEX_APPROVAL_POLICY: policy.approvalPolicy } } : {}),
    credentials: createCredentialStore(credsDir),
    // Session-less catalog contribution: Codex runs OpenAI models under a ChatGPT
    // subscription (provider id "openai-codex"). The authoritative per-session
    // list comes from the app-server; this is the picker preview.
    catalog: [
      {
        id: "openai-codex",
        name: "OpenAI Codex (ChatGPT)",
        oauth: true,
        models: [
          { provider: "openai-codex", id: "gpt-5-codex", name: "GPT-5 Codex", reasoning: true },
          { provider: "openai-codex", id: "gpt-5", name: "GPT-5", reasoning: true },
        ],
      },
    ],
    capabilities: { toolInterception: true, modelSelection: true, resume: true, nativeSessionDiscovery: true, nativeSessionAdoption: true },
    // Resume: the shim reconnects a prior thread via thread/resume by its rollout
    // id, and history preloads from the same on-disk rollout the exec path reads —
    // so takeover/reopen continues a governed session. (Validated on codex-cli
    // 0.144.1; the app-server threadId == the rollout/session id.)
    resumable: true,
    loadHistory: (sessionId) => loadCodexTranscript(sessionId),
    deleteHistory: (sessionId) => void deleteCodexSession(sessionId),
    // True cross-runtime replay INTO Codex: synthesise a resumable rollout from
    // portable history so a fork from another agent opens on a copy of the whole
    // conversation instead of a seeded summary (best-effort — see writeCodexRollout).
    writeHistory: (history, ctx) => writeCodexRollout(history, ctx.cwd || ctx.workspace),
    suggestName: suggestCodexSessionName,
    // Native discovery (issue #156): enumerate Codex rollouts on this node that
    // Bivy didn't start, so a pre-existing `codex` session can be adopted here
    // (the governed variant), never the plain exec runtime below.
    discoverNativeSessions: () => discoverNativeCodexSessions(),
  });
}

// --- #2: the GENERAL ACP adapter (Agent Client Protocol) --------------------
// Generalizes the app-server shim pattern to the open ACP standard: any ACP agent
// (e.g. `gemini --experimental-acp`) is driven through bin/acp-shim.mjs → the same
// ProtocolRuntime that backs Codex approvals, so it gets per-tool Approve/Deny,
// streaming, and resume with ZERO per-agent code. Configured as data via
// BIVY_ACP_COMMAND / BIVY_ACP_ARGS (mirrors generic-cli / bivy-agent-protocol);
// hidden from the picker until validated against a given agent, then promotable
// with one catalog edit. Returns null when BIVY_ACP_COMMAND isn't set.
/** Absolute path to the ACP bridge shim. */
function acpShimPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "acp-shim.mjs");
}

/**
 * Build ProtocolRuntime options that drive an ACP agent (`command` + `agentArgs`)
 * through bin/acp-shim.mjs. Shared by the generic `acp` runtime and the per-agent
 * ACP promotion path so both wrap agents identically.
 */
function acpRuntimeOptions(opts: { id: string; displayName: string; command: string; agentArgs: string[]; credsDir?: string }): ProtocolRuntimeOptions {
  return {
    id: opts.id,
    displayName: opts.displayName,
    command: process.execPath,
    args: [acpShimPath(), "--agent", opts.command, "--", ...opts.agentArgs],
    // Seed governed+resumable up front so the daemon attaches guardianInterceptor to
    // the FIRST session (before the shim's hello lands); the hello confirms them.
    capabilities: { toolInterception: true, resume: true },
    resumable: true,
    ...(opts.credsDir ? { credentials: createCredentialStore(opts.credsDir) } : {}),
  };
}

function acpRuntimeFromEnv(credsDir?: string): ProtocolRuntimeOptions | null {
  const command = process.env.BIVY_ACP_COMMAND?.trim();
  if (!command) return null;
  let agentArgs: string[] = [];
  const rawArgs = process.env.BIVY_ACP_ARGS?.trim();
  if (rawArgs) {
    try { const p = JSON.parse(rawArgs); if (Array.isArray(p)) agentArgs = p.map(String); } catch { /* ignore malformed */ }
  }
  return acpRuntimeOptions({ id: "acp", displayName: process.env.BIVY_ACP_NAME?.trim() || "ACP Agent", command, agentArgs, credsDir });
}

/**
 * Whether a CLI agent should be driven through ACP rather than the one-shot pipe:
 * it declares an `acp` mode AND ACP is preferred for it (per-agent `BIVY_<ID>_ACP=1`
 * or global `BIVY_PREFER_ACP=1`). This is the data-driven "promote an agent to the
 * high-capability path" switch — no per-agent code, just a spec field + a flag.
 */
function prefersAcp(id: CliAgentId): boolean {
  if (!CLI_AGENT_SPECS[id].acp) return false;
  return process.env.BIVY_PREFER_ACP === "1" || process.env[`BIVY_${id.toUpperCase()}_ACP`] === "1";
}

function acpInfo(): RuntimeInfo {
  const configured = Boolean(process.env.BIVY_ACP_COMMAND?.trim());
  return {
    id: "acp",
    displayName: process.env.BIVY_ACP_NAME?.trim() || "ACP Agent",
    description: "Any Agent Client Protocol (ACP) agent, driven through Bivy's shim for per-tool approvals, streaming, and resume.",
    status: configured ? "available" : "planned",
    packageName: process.env.BIVY_ACP_COMMAND?.trim() || "Set BIVY_ACP_COMMAND",
    language: "Process",
    capabilities: { toolInterception: true, modelSelection: false, resume: true, packages: false, fork: false },
    supportTier: "experimental",
    authOwner: "agent",
    notes: configured
      ? "Drives an ACP agent via bin/acp-shim.mjs → ProtocolRuntime: per-tool Approve/Deny, streaming transcript, and session/load resume — no per-agent code. Validate against your agent, then promote it into the picker as data."
      : "Set BIVY_ACP_COMMAND (and optional BIVY_ACP_ARGS, a JSON array) to the ACP agent's launch command, e.g. BIVY_ACP_COMMAND=gemini BIVY_ACP_ARGS='[\"--experimental-acp\"]'.",
  };
}

function splitEnvArgs(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
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

function openClawProcessOptions() {
  const command = process.env.BIVY_OPENCLAW_COMMAND?.trim() || "openclaw";
  const args = splitEnvArgs(process.env.BIVY_OPENCLAW_ARGS, ["agent", "--message"]);
  const agent = process.env.BIVY_OPENCLAW_AGENT?.trim();
  const agentFlagIndex = args.indexOf("--message");
  const argsWithAgent = !agent ? args : agentFlagIndex >= 0
    ? [...args.slice(0, agentFlagIndex), "--agent", agent, ...args.slice(agentFlagIndex)]
    : [...args, "--agent", agent];
  return {
    id: "openclaw",
    displayName: agent ? `OpenClaw (${agent})` : "OpenClaw",
    command,
    args: argsWithAgent,
    promptMode: "argv" as const,
  };
}

function openClawInfo(): RuntimeInfo {
  const options = openClawProcessOptions();
  const installed = commandAvailable(options.command);
  const npmPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || "~/.local";
  const installCommand = `npm install --global --prefix ${npmPrefix} openclaw`;
  return {
    id: "openclaw",
    displayName: options.displayName,
    description: "Run the local OpenClaw CLI underneath Bivy in the session workspace.",
    status: installed ? "available" : "external",
    packageName: "openclaw",
    language: "Process",
    capabilities: { toolInterception: false, modelSelection: false, resume: false, packages: false, fork: false },
    supportTier: "experimental",
    authOwner: "agent",
    notes: installed
      ? "Available on PATH. This phase-1 CLI adapter streams stdout/stderr only; Gateway RPC and structured tool approvals require a future OpenClaw protocol bridge. Configure with BIVY_OPENCLAW_COMMAND, BIVY_OPENCLAW_ARGS, and BIVY_OPENCLAW_AGENT."
      : `${options.command} was not found on PATH. Install OpenClaw on this node, use the PWA install button, or set BIVY_OPENCLAW_COMMAND to its CLI path.`,
    install: installed ? undefined : {
      label: "Install OpenClaw",
      description: `Install the OpenClaw CLI on this node now (${installCommand}).`,
      command: installCommand,
    },
  };
}

function protocolInfo(): RuntimeInfo {
  const configured = Boolean(protocolRuntimeFromEnv());
  // Surface any BIVY_PROTOCOL_COMMANDS-seeded slash commands in the catalog so
  // the composer can offer them in autocomplete before the first session's hello
  // (discovery reads this RuntimeInfo, not the live runtime's refined caps).
  const commands = protocolCommandsFromEnv();
  return {
    id: "bivy-agent-protocol",
    displayName: process.env.BIVY_PROTOCOL_NAME?.trim() || "Bivy Protocol",
    description: "JSON-lines process protocol for any agent to expose structured events, tool calls, approvals, models, and sessions without a bespoke Bivy adapter.",
    status: configured ? "available" : "planned",
    packageName: process.env.BIVY_PROTOCOL_COMMAND?.trim() || "stdio/jsonl",
    language: "Any",
    capabilities: { toolInterception: true, modelSelection: true, resume: true, packages: false, fork: false, ...(commands ? { commands } : {}) },
    supportTier: "experimental",
    authOwner: "mixed",
    notes: configured
      ? "Configured through BIVY_PROTOCOL_COMMAND / BIVY_PROTOCOL_ARGS. Advertise agent-native slash commands with BIVY_PROTOCOL_COMMANDS (JSON [{name,description}]); other capability flags are finalized by the agent handshake."
      : "Set BIVY_PROTOCOL_COMMAND to enable a JSONL Bivy Agent Protocol runtime.",
  };
}

export const RUNTIME_CATALOG: RuntimeInfo[] = [
  {
    id: "pi",
    displayName: "Pi",
    description: "Native Bivy/Pi coding agent runtime with packages, approvals, and model picker.",
    status: "available",
    packageName: "@earendil-works/pi-coding-agent",
    language: "TypeScript",
    capabilities: PI_CAPABILITIES,
    supportTier: "supported",
    authOwner: "bivy",
  },
  genericCliInfo(),
  // `codex` sits before the governed shim it feeds; the rest of the CLI agents are
  // derived straight from CLI_AGENT_SPECS (adding a spec = one data edit, no list
  // to keep in sync here).
  cliAgentInfo("codex"),
  codexApprovalsInfo(),
  ...CLI_AGENT_IDS.filter((id) => id !== "codex").map(cliAgentInfo),
  openClawInfo(),
  claudeCodeInfo(),
  protocolInfo(),
  acpInfo(),
  {
    id: "openhands",
    displayName: "OpenHands",
    description: "Open-source autonomous software engineering agent, usually run as an app/server with sandboxed execution.",
    status: "planned",
    packageName: "openhands-ai/openhands",
    language: "Python",
    capabilities: { toolInterception: false, modelSelection: true, resume: true, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "agent",
    notes: "Likely needs a server/protocol adapter rather than the generic CLI path so Bivy can map tasks, logs, files, and approvals cleanly.",
  },
  {
    id: "swe-agent",
    displayName: "SWE-agent",
    description: "Batch/task-oriented open-source software engineering agent for issue-to-patch workflows.",
    status: "planned",
    packageName: "swe-agent",
    language: "Python",
    capabilities: { toolInterception: false, modelSelection: true, resume: false, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "agent",
    notes: "Strong fit for GitHub issue queue runs; likely exposed as a task runner/protocol adapter rather than conversational chat.",
  },

  {
    id: "openai-agents-sdk",
    displayName: "OpenAI Agents SDK",
    description: "OpenAI's agent framework with tools, handoffs, guardrails, and tracing.",
    status: "planned",
    packageName: "@openai/agents",
    language: "TypeScript/Python",
    capabilities: { toolInterception: true, modelSelection: true, resume: false, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "mixed",
    notes: "Good candidate for non-coding workflows; needs a coding-tool bundle to match Pi/Claude Code behavior.",
  },
  {
    id: "langgraph",
    displayName: "LangGraph",
    description: "Stateful agent graph runtime from LangChain for durable multi-step workflows.",
    status: "planned",
    packageName: "@langchain/langgraph",
    language: "TypeScript/Python",
    capabilities: { toolInterception: true, modelSelection: true, resume: true, packages: false, fork: true },
    supportTier: "planned",
    authOwner: "mixed",
    notes: "Strong for custom orchestrations; coding-agent semantics would be defined by our graph and tools.",
  },
  {
    id: "google-adk",
    displayName: "Google ADK",
    description: "Google Agent Development Kit for Gemini-oriented agents.",
    status: "planned",
    packageName: "google-adk",
    language: "Python",
    capabilities: { toolInterception: true, modelSelection: true, resume: false, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "mixed",
    notes: "Likely via a sidecar process/RPC adapter because the primary SDK is Python."
  },
  {
    id: "autogen",
    displayName: "AutoGen",
    description: "Microsoft's multi-agent conversation framework.",
    status: "planned",
    packageName: "autogen-agentchat",
    language: "Python/.NET",
    capabilities: { toolInterception: true, modelSelection: true, resume: false, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "mixed",
    notes: "Best suited for multi-agent workflows; use a sidecar adapter for Bivy.",
  },
  {
    id: "crew-ai",
    displayName: "CrewAI",
    description: "Python framework for role-based multi-agent task crews.",
    status: "planned",
    packageName: "crewai",
    language: "Python",
    capabilities: { toolInterception: true, modelSelection: true, resume: false, packages: false, fork: false },
    supportTier: "planned",
    authOwner: "mixed",
    notes: "Use for workflow/crew tasks rather than low-latency coding sessions; sidecar adapter recommended.",
  },

];

// Agents Bivy fully integrates today and therefore shows in the agent picker —
// the most-used coding agents, all driven through Bivy's general paths (the
// native Pi/Claude runtimes, the Codex app-server shim, and the data-driven CLI
// ProcessRuntime + CliParser path) rather than bespoke per-agent code:
//
//   pi, claude-code-sdk         — native runtimes (approvals, models, resume)
//   codex-approvals             — Codex via the app-server shim (approvals + resume)
//   opencode, gemini, qwen,     — CLI agents on the shared ProcessRuntime path:
//   goose, aider, cline, crush,   structured streaming (JSON parser where the CLI
//   cursor, copilot, grok, amp,   has one), effect-level governance (sandbox tier /
//   auggie, droid, continue,      FS-MCP-network channels), honest capabilities
//   kilocode, rovodev             (resume/model advertised only where the CLI
//                                 actually drives it).
//
// "Codex" here is the app-server *shim* runtime (`codex-approvals`): governed
// (per-tool Approve/Deny) AND resumable (thread/resume by rollout id), which
// strictly supersedes the plain `codex` exec runtime; that exec path stays
// runnable via `BIVY_RUNTIME=codex` for the fast, no-approval flow.
//
// Everything else in RUNTIME_CATALOG is an extension hook that only works once
// configured via env (generic-cli, bivy-agent-protocol), a niche/phase-1 adapter
// (hermes, openclaw), or an aspirational "planned" placeholder with no adapter.
// They are hidden from the picker to keep it honest, but remain fully runnable via
// `BIVY_RUNTIME=<id>`. To promote a CLI agent into the picker, give it honest
// capabilities (no silently-no-op pickers) and drop its `hidden: true` flag in
// CLI_AGENT_SPECS — the picker set below derives from that one field.
// See docs/agents-not-fully-supported.md for the rationale and the promotion path.
//
// The picker = the native/shim runtimes that aren't CLI-agent specs, PLUS every
// non-hidden CLI agent. Visibility lives on the spec (`hidden`), so promoting or
// demoting an agent is a single data edit with no id list to drift.
const NON_CLI_PICKER_IDS = ["pi", "claude-code-sdk", "codex-approvals"];
const PICKER_RUNTIME_IDS = new Set<string>([
  ...NON_CLI_PICKER_IDS,
  ...CLI_AGENT_IDS.filter((id) => !CLI_AGENT_SPECS[id].hidden),
]);

export function listRuntimes(currentId?: string): (RuntimeInfo & { current: boolean })[] {
  return RUNTIME_CATALOG
    // Keep the current runtime visible even if hidden, so a session pinned to a
    // hidden agent (e.g. someone running BIVY_RUNTIME=goose) still renders its
    // selection instead of showing an empty picker.
    .filter((runtime) => PICKER_RUNTIME_IDS.has(runtime.id) || runtime.id === currentId)
    .map((runtime) => {
      if (runtime.id === "generic-cli") return genericCliInfo();
      if (isCliAgentId(runtime.id)) return cliAgentInfo(runtime.id);
      if (runtime.id === "codex-approvals") return codexApprovalsInfo();
      if (runtime.id === "openclaw") return openClawInfo();
      if (runtime.id === "claude-code-sdk") return claudeCodeInfo();
      if (runtime.id === "bivy-agent-protocol") return protocolInfo();
      if (runtime.id === "acp") return acpInfo();
      return runtime;
    }).map((runtime) => ({ ...runtime, current: runtime.id === currentId }));
}

export function makeRuntime(options: RuntimeFactoryOptions): AgentRuntime {
  const id = (options.runtime ?? process.env.BIVY_RUNTIME ?? "pi").toLowerCase();
  switch (id) {
    case "pi":
      return new PiRuntime(options);
    case "generic-cli": {
      const processOptions = processRuntimeFromEnv();
      if (!processOptions) throw new Error("generic-cli requires BIVY_AGENT_COMMAND to be set.");
      // Share the node's provider logins (the shared vault) so the CLI agent finds
      // whatever model key it needs without a separate per-agent sign-in.
      // BIVY_AGENT_PARSER opts this agent into Phase 4 structured mode (fidelity).
      return new ProcessRuntime({ ...processOptions, credentials: createCredentialStore(options.credsDir), parserFactory: parserFactoryFor(process.env.BIVY_AGENT_PARSER) });
    }
    case "codex-approvals": {
      // Tier 2, per-session: the user picked governed Codex from the agent picker.
      // Drives Codex's app-server through the bivy-agent-protocol shim so each
      // shell/patch the model proposes becomes a pre-execution Approve/Deny card
      // via guardianInterceptor — not just the effect-level exec jail.
      if (!commandAvailable("codex")) throw new Error("Codex command not found on PATH: codex");
      return codexAppServerRuntime(options.credsDir, sandboxTier(options.sandbox));
    }
    case "openclaw": {
      const openClawOptions = openClawProcessOptions();
      if (!commandAvailable(openClawOptions.command)) throw new Error(`OpenClaw command not found on PATH: ${openClawOptions.command}`);
      // OpenClaw owns its own auth profiles by default; Bivy only supervises the
      // local CLI process in this phase-1 adapter.
      return new ProcessRuntime(openClawOptions);
    }
    case "bivy-agent-protocol": {
      const protocolOptions = protocolRuntimeFromEnv();
      if (!protocolOptions) throw new Error("bivy-agent-protocol requires BIVY_PROTOCOL_COMMAND to be set.");
      return new ProtocolRuntime({ ...protocolOptions, credentials: createCredentialStore(options.credsDir) });
    }
    case "acp": {
      const acpOptions = acpRuntimeFromEnv(options.credsDir);
      if (!acpOptions) throw new Error("acp requires BIVY_ACP_COMMAND to be set (the ACP agent's launch command, e.g. gemini).");
      return new ProtocolRuntime(acpOptions);
    }
    case "claude":
    case "claude-code":
    case "claude-code-sdk":
      // Share the node's provider logins (the shared vault) so the user doesn't
      // re-auth Anthropic for this agent.
      return new ClaudeCodeRuntime({ ...claudeRuntimeFromEnv(), credentials: createCredentialStore(options.credsDir), sandbox: options.sandbox, attachToChat: options.attachToChat });
    default:
      // Every CLI agent in CLI_AGENT_SPECS is dispatched here as data — no per-id
      // case to maintain. Anything that isn't a known CLI agent throws below.
      if (isCliAgentId(id)) return makeCliRuntime(id, options);
      throw new Error(`Unknown or unavailable BIVY_RUNTIME "${id}". Available runtimes: pi, openclaw/codex/opencode/aider/hermes/goose/gemini/qwen/cline/crush/cursor/copilot/grok/amp/auggie/droid/continue/kilocode/rovodev/codebuff (when their CLI is installed), generic-cli (when BIVY_AGENT_COMMAND is set), claude-code-sdk (when @anthropic-ai/claude-agent-sdk is installed).`);
  }
}

/**
 * Build a ProcessRuntime for any CLI agent from its CLI_AGENT_SPECS entry — the
 * single data-driven launch path (structured JSON mode where a parser exists,
 * effect-level governance, generic resume). Extracted from the makeRuntime switch
 * so adding an agent stays a pure-data change.
 */
function makeCliRuntime(id: CliAgentId, options: RuntimeFactoryOptions): AgentRuntime {
      const spec = CLI_AGENT_SPECS[id];
      if (!commandAvailable(spec.command)) throw new Error(`${spec.displayName} command not found on PATH: ${spec.command}`);
      // ACP promotion: when the agent declares an `acp` mode and it's preferred
      // (BIVY_<ID>_ACP=1 / BIVY_PREFER_ACP=1), drive it through the governed
      // ProtocolRuntime (per-tool approvals + streaming + resume) instead of the
      // one-shot pipe below — the high-capability path, selected as data.
      if (spec.acp && prefersAcp(id)) {
        return new ProtocolRuntime(acpRuntimeOptions({ id, displayName: spec.displayName, command: spec.command, agentArgs: spec.acp.args, credsDir: options.credsDir }));
      }
      // Phase 4 — structured mode ON by default when the agent has a VALIDATED JSON
      // parser: launch with its native JSON flags and parse stdout into normalized
      // events. BIVY_AGENT_STRUCTURED=0 forces the dumb-pipe fallback everywhere;
      // BIVY_AGENT_STRUCTURED=1 opts INTO structured mode for agents whose parser
      // is still unverified (spec.parserUnverified — safe default is dumb pipe so a
      // wrong flag can't regress a working agent). BIVY_AGENT_PARSER overrides the
      // parser id (e.g. to "bivy-protocol").
      const structuredPref = process.env.BIVY_AGENT_STRUCTURED;
      const parserReady = Boolean(spec.parserId) && (!spec.parserUnverified || structuredPref === "1");
      const structured = parserReady && structuredPref !== "0";
      const parserId = process.env.BIVY_AGENT_PARSER || (structured ? spec.parserId : undefined);
      const tier = sandboxTier(options.sandbox);
      // BIVY_<ID>_ARGS overrides the launch flags for a CLI version we haven't
      // pinned; else composeArgs (native sandbox) wins; else structured jsonArgs;
      // else the plain args.
      const runArgs = cliArgsOverride(id as CliAgentId)
        ?? (spec.composeArgs
          ? spec.composeArgs({ structured, tier })
          : structured && spec.jsonArgs
            ? spec.jsonArgs
            : spec.args);
      // Codex reads OPENAI_API_KEY or its own `$CODEX_HOME/auth.json`. When the
      // user connected a ChatGPT/Codex subscription in Bivy (but hasn't run
      // `codex login`), `prepare` mints that auth file from the shared vault so
      // the run just works; the preflight still catches the genuinely
      // uncredentialed case with an actionable message instead of an opaque 401.
      const preflight =
        id === "codex"
          ? (env: Record<string, string | undefined>) => codexCredentialPreflight(env)
          : id === "opencode"
            ? (env: Record<string, string | undefined>, ctx: { provider?: string }) => opencodeCredentialPreflight(env, ctx)
            : undefined;
      const prepare = id === "codex"
        ? async (): Promise<Record<string, string>> => {
            const home = await ensureCodexAuth(options.credsDir);
            return home ? { CODEX_HOME: home } : {};
          }
        : undefined;
      // Resume, the generic way. Codex keeps its verified path (rollout history +
      // tier-aware `codex exec resume <id> --json`). Every other CLI agent becomes
      // resumable purely as data: a spec.resume template (or a BIVY_<ID>_RESUME_
      // TEMPLATE override) whose {id}/{tier}/{sandbox} placeholders are filled per
      // prompt — no per-agent code. Absent = fresh process per prompt (resume
      // stays off; see the per-agent comments in CLI_AGENT_SPECS for why some
      // genuinely have no native "continue session <id>" form).
      const resumeTemplate = id === "codex" ? undefined : cliResumeTemplate(id as CliAgentId);
      const resumeOpts = id === "codex"
        ? {
            resumable: true,
            loadHistory: (sessionId: string) => loadCodexTranscript(sessionId),
            deleteHistory: (sessionId: string) => void deleteCodexSession(sessionId),
            resumeArgs: (sessionId: string) => codexResumeArgs(sessionId, tier),
          }
        : resumeTemplate
          ? {
              resumable: true,
              loadHistory: spec.resume?.loadHistory,
              // `{sandbox}` expands to that agent's native containment flags for
              // the tier (e.g. Gemini/Qwen's `--approval-mode <mode>`) — a whole
              // token, not a string substitution, since it can be multiple argv
              // words; `{id}`/`{tier}` stay plain per-token string replacement.
              resumeArgs: (sessionId: string) =>
                resumeTemplate.flatMap((a) =>
                  a === "{sandbox}"
                    ? sandboxArgsFor(id, tier)
                    : [a.replace(/\{id\}/g, sessionId).replace(/\{tier\}/g, tier)],
                ),
            }
          : {};
      return new ProcessRuntime({ id, displayName: spec.displayName, command: spec.command, args: runArgs, promptMode: spec.promptMode, credentials: createCredentialStore(options.credsDir), parserFactory: parserFactoryFor(parserId), preflight, prepare, model: cliModelConfig(id), thinking: cliThinkingConfig(id), usageReporting: cliUsageReporting(id), ...resumeOpts });
}
