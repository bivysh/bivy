// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Runtime registry. Selects the agent runtime by BIVY_RUNTIME (default "pi").
// This is the seam where additional runtimes (Claude Agent SDK, generic RPC,
// …) are registered without touching the daemon.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRuntime, claudeRuntimeFromEnv, claudeSdkInstalled } from "./claude-code.js";
import { deleteCodexSession, discoverNativeCodexSessions, loadCodexTranscript } from "./codex-sessions.js";
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
import { ProtocolRuntime, protocolRuntimeFromEnv, protocolCommandsFromEnv } from "./protocol.js";
import type { AgentRuntime, RuntimeCapabilities } from "./types.js";

export * from "./types.js";
export { NodeCredentialResolver, createCredentialStore } from "./credentials.js";

export interface RuntimeFactoryOptions extends PiRuntimeOptions {
  /** Override the runtime; defaults to BIVY_RUNTIME or "pi". */
  runtime?: string;
  /** Per-session sandbox tier override (else the node default is used). */
  sandbox?: SandboxTier;
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

type CliAgentId = "codex" | "opencode" | "aider" | "hermes" | "goose" | "gemini" | "qwen" | "cline" | "crush";

type CliAgentSpec = {
  displayName: string;
  command: string;
  packageName: string;
  promptMode: ProcessPromptMode;
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
   * Native exec sandbox. When set, builds the full launch args for a given
   * structured-mode + sandbox tier, inserting the agent's native sandbox/approval
   * flags in the right place (the prompt is appended by ProcessRuntime after
   * these). Takes precedence over args/jsonArgs. Agents without a native sandbox
   * omit this and fall back to args/jsonArgs.
   */
  composeArgs?: (opts: { structured: boolean; tier: SandboxTier }) => string[];
  installCommand?: (npmPrefix: string) => { command: string };
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
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} @openai/codex`,
    }),
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
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} opencode-ai`,
    }),
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
    installCommand: () => ({
      command: "python3 -m pip install --user aider-chat",
    }),
  },
  hermes: {
    displayName: "Hermes",
    command: "hermes",
    // The npm package is `hermes-agent` (ships the `hermes` bin); the bare
    // `hermes` package is an unrelated abandoned segmentio lib.
    packageName: "hermes-agent",
    promptMode: "argv",
    // No `resume`: dumb-pipe adapter with no validated JSON parser or documented
    // session/resume flag — see docs/agents-not-fully-supported.md.
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} hermes-agent`,
    }),
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
    promptMode: "argv",
    supportTier: "beta",
    blurb: "Block's open-source agent with a structured stream-json protocol (Goose).",
    // Homebrew isn't present on stock Linux nodes (brew → ENOENT); the official
    // download script installs the goose binary on both Linux and macOS.
    installCommand: () => ({ command: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash" }),
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
    promptMode: "argv",
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} @google/gemini-cli`,
    }),
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
    promptMode: "argv",
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} @qwen-code/qwen-code`,
    }),
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
    promptMode: "argv",
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} cline`,
    }),
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
    installCommand: (npmPrefix: string) => ({
      command: `npm install --global --prefix ${npmPrefix} @charmland/crush`,
    }),
  },
};

function isCliAgentId(id: string): id is CliAgentId {
  return Object.prototype.hasOwnProperty.call(CLI_AGENT_SPECS, id);
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

function cliAgentInfo(id: CliAgentId): RuntimeInfo {
  const spec = CLI_AGENT_SPECS[id];
  const installed = commandAvailable(spec.command);
  const npmPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || "~/.local";
  const installCommand = spec.installCommand?.(npmPrefix);
  // Honesty invariant (see docs/agents-not-fully-supported.md): capabilities must
  // reflect what the ProcessRuntime path actually delivers, or the PWA renders a
  // picker that silently no-ops. These CLI adapters stream stdout (structured via
  // a CliParser when the agent has a validated JSON mode, else raw) and are
  // governed at the effect level (sandbox tier / FS-MCP-network channels), so
  // toolInterception + modelSelection stay false. resume is on only when the
  // agent has a known resume form (spec.resume or a BIVY_<ID>_RESUME_TEMPLATE
  // override) — Codex is the built-in example; the rest are fresh-process-per-
  // prompt until a resume template is wired.
  const resume = id === "codex" || Boolean(cliResumeTemplate(id));
  const modelSelection = Boolean(cliModelConfig(id));
  const usageReporting = cliUsageReporting(id);
  return {
    id,
    displayName: spec.displayName,
    description: spec.blurb ?? `Run the local ${spec.displayName} CLI underneath Bivy in the session workspace.`,
    status: installed ? "available" : "external",
    packageName: spec.packageName,
    language: "Process",
    capabilities: { toolInterception: false, modelSelection, resume, packages: false, fork: false, usageReporting, sessionDiscovery: id === "codex" },
    supportTier: spec.supportTier ?? (id === "codex" ? "supported" : "experimental"),
    authOwner: spec.authOwner ?? "agent",
    notes: installed
      ? `Available on PATH. This process adapter ${spec.parserId ? "parses its native JSON stream into a structured transcript" : "streams stdout/stderr"}; Bivy governs its filesystem/exec/MCP effects at the sandbox tier rather than intercepting each tool call. Override its launch flags with BIVY_${id.toUpperCase()}_ARGS if your CLI version differs.`
      : `${spec.command} was not found on PATH. Install it on this node, then select this agent again.`,
    install: installed || !installCommand ? undefined : {
      label: `Install ${spec.displayName}`,
      description: `Install ${spec.displayName} on this node now (${installCommand.command}).`,
      command: installCommand.command,
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
    suggestName: suggestCodexSessionName,
    // Native discovery (issue #156): enumerate Codex rollouts on this node that
    // Bivy didn't start, so a pre-existing `codex` session can be adopted here
    // (the governed variant), never the plain exec runtime below.
    discoverNativeSessions: () => discoverNativeCodexSessions(),
  });
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
  cliAgentInfo("codex"),
  codexApprovalsInfo(),
  cliAgentInfo("opencode"),
  cliAgentInfo("aider"),
  cliAgentInfo("hermes"),
  cliAgentInfo("goose"),
  cliAgentInfo("gemini"),
  cliAgentInfo("qwen"),
  cliAgentInfo("cline"),
  cliAgentInfo("crush"),
  openClawInfo(),
  claudeCodeInfo(),
  protocolInfo(),
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
// the ten most-used coding agents, all driven through Bivy's general paths (the
// native Pi/Claude runtimes, the Codex app-server shim, and the data-driven CLI
// ProcessRuntime + CliParser path) rather than bespoke per-agent code:
//
//   pi, claude-code-sdk         — native runtimes (approvals, models, resume)
//   codex-approvals             — Codex via the app-server shim (approvals + resume)
//   opencode, gemini, qwen,     — CLI agents on the shared ProcessRuntime path:
//   goose, aider, cline, crush    structured streaming (JSON parser where the CLI
//                                 has one), effect-level governance (sandbox tier /
//                                 FS-MCP-network channels), honest capabilities.
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
// `BIVY_RUNTIME=<id>`. To promote one into the picker, give it honest capabilities
// (no silently-no-op pickers) and add its id here.
// See docs/agents-not-fully-supported.md for the rationale and the promotion path.
const PICKER_RUNTIME_IDS = new Set([
  "pi",
  "claude-code-sdk",
  "codex-approvals",
  "opencode",
  "gemini",
  "qwen",
  "goose",
  "aider",
  "cline",
  "crush",
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
    case "codex":
    case "opencode":
    case "aider":
    case "hermes":
    case "goose":
    case "gemini":
    case "qwen":
    case "cline":
    case "crush": {
      const spec = CLI_AGENT_SPECS[id as CliAgentId];
      if (!commandAvailable(spec.command)) throw new Error(`${spec.displayName} command not found on PATH: ${spec.command}`);
      // Phase 4 — structured mode ON by default when the agent has a validated
      // JSON parser: launch with its native JSON flags and parse stdout into
      // normalized events. BIVY_AGENT_STRUCTURED=0 forces the dumb-pipe fallback;
      // BIVY_AGENT_PARSER overrides the parser id (e.g. to "bivy-protocol").
      const structured = Boolean(spec.parserId) && process.env.BIVY_AGENT_STRUCTURED !== "0";
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
      return new ProcessRuntime({ id, displayName: spec.displayName, command: spec.command, args: runArgs, promptMode: spec.promptMode, credentials: createCredentialStore(options.credsDir), parserFactory: parserFactoryFor(parserId), preflight, prepare, model: cliModelConfig(id as CliAgentId), thinking: cliThinkingConfig(id as CliAgentId), usageReporting: cliUsageReporting(id as CliAgentId), ...resumeOpts });
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
    case "claude":
    case "claude-code":
    case "claude-code-sdk":
      // Share the node's provider logins (the shared vault) so the user doesn't
      // re-auth Anthropic for this agent.
      return new ClaudeCodeRuntime({ ...claudeRuntimeFromEnv(), credentials: createCredentialStore(options.credsDir), sandbox: options.sandbox });
    default:
      throw new Error(`Unknown or unavailable BIVY_RUNTIME "${id}". Available runtimes: pi, openclaw/codex/opencode/aider/hermes/goose/gemini/qwen/cline/crush (when their CLI is installed), generic-cli (when BIVY_AGENT_COMMAND is set), claude-code-sdk (when @anthropic-ai/claude-agent-sdk is installed).`);
  }
}
