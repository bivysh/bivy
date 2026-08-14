// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Maintained, declarative profiles for agents Bivy can discover on the user's
 * PATH. These records describe integrations; they do not bundle or implement
 * the upstream agents.
 */
import { sandboxArgsFor, type SandboxTier } from "../harness/sandbox.js";
import { loadGrokTranscript } from "../runtime/grok-sessions.js";
import type { ProcessPromptMode } from "../runtime/process.js";
import type { RuntimeMessage } from "../runtime/types.js";
import type { AgentSupportTier } from "./types.js";


export type AgentProfileId =
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
export type AgentInstallDescriptor =
  | { kind: "npm"; pkg: string }
  | { kind: "pip"; pkg: string }
  | { kind: "curl"; display: string; shell: string };

export type AgentProfile = {
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
  /** Structured, data-driven install descriptor (see AgentInstallDescriptor). */
  install?: AgentInstallDescriptor;
  /** Support tier surfaced in the picker. Defaults to "beta". */
  supportTier?: AgentSupportTier;
  /** Exact CLI version last exercised by release certification, when pinned. */
  testedVersion?: string;
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
   * of the one-shot stdout pipe — no other spec change needed.
   *
   * `preferred` promotes the agent to ACP BY DEFAULT — the honest default only for
   * an agent whose ACP mode we've validated end-to-end, and only when the installed
   * binary actually evidences it. A default-on promotion is always gated on
   * `acpSupportedByBinary()` (a cached `--help` probe for `helpToken`), so a node
   * running an older CLI without the ACP subcommand silently keeps the pipe path
   * with its honest, lower capabilities instead of failing to open a session.
   * `BIVY_<ID>_ACP=0` forces the pipe path back on; `=1` forces ACP without the
   * probe (operator override). Agents without `preferred` stay opt-in.
   */
  acp?: { args: string[]; helpToken?: string; preferred?: boolean; declared?: boolean };
  /** The manifest declares ACP as the only valid adapter; there is no process
   *  fallback to select when protocol startup is unavailable. */
  protocolOnly?: boolean;
};

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
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
    // Supported tier: OpenCode runs on the governed ACP path by default (per-tool
    // Approve/Deny + session/load resume + a real model picker), the same bar Pi,
    // Claude Code, and Codex clear. See `acp` below for the version fallback.
    supportTier: "supported",
    testedVersion: "1.18.13",
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
        // OpenCode's own gateway ("opencode Zen") serves the openai-codex frontier
        // line (`opencode/gpt-5.6-sol`) without a separate provider key — the honest
        // default to surface first. The provider-scoped ids below resolve once the
        // matching provider is configured in OpenCode.
        { id: "opencode/gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "opencode" },
        { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
        { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
      ],
    },
    // `opencode acp` ("start ACP (Agent Client Protocol) server") drives OpenCode
    // through the governed ProtocolRuntime instead of the one-shot pipe: per-tool
    // Approve/Deny, streaming, `session/load` resume, and `session/set_model`.
    // Validated against opencode 1.18.13, so it is ON by default (`preferred`) —
    // gated on the binary actually listing the `acp` subcommand, so an older
    // OpenCode falls back to the pipe path rather than opening a dead session.
    // Force the pipe path back with BIVY_OPENCODE_ACP=0.
    acp: { args: ["acp"], helpToken: "acp", preferred: true },
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
    packageName: "grok (curl -fsSL https://x.ai/cli/install.sh | bash)",
    supportTier: "beta",
    authOwner: "mixed",
    blurb: "xAI's official Grok coding agent (Grok CLI) — SuperGrok/X subscription or API key.",
    // Official CLI: `grok -p "<prompt>"` (alias `--single`) runs one headless
    // turn; `-m <id>` picks the model. Auth is projected from Bivy's vault:
    // subscription → ~/.grok/auth.json (grok-auth.ts), API key → XAI_API_KEY /
    // GROK_API_KEY. The older @vibe-kit/grok-cli only accepts API keys — install
    // the official binary for OAuth to work.
    //
    // Resume: `grok --resume <id> -p "<prompt>"` continues a prior session by
    // UUID (sessions live under ~/.grok/sessions/<cwd>/<id>/). The interactive
    // TUI uses the same store via `grok --resume <id>`. Model ids match
    // `grok models` for the official CLI (override with BIVY_GROK_MODELS).
    args: ["-p"],
    resume: {
      template: ["--resume", "{id}", "-p"],
      loadHistory: (sessionId: string) => loadGrokTranscript(sessionId),
    },
    model: {
      flag: "-m",
      models: [
        // Official Grok CLI (1.x) currently advertises grok-4.5 as the default
        // subscription model. Older curated ids (grok-4-latest, grok-code-fast-1,
        // …) return "unknown model id" against current CLIs — keep the list
        // honest; operators can override with BIVY_GROK_MODELS if their install
        // exposes more.
        { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
      ],
    },
    promptMode: "argv",
    install: {
      kind: "curl",
      display: "curl -fsSL https://x.ai/cli/install.sh | bash",
      shell: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
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
    // Hidden from the picker by this registration metadata. The `codebuff` binary has no
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

export const AGENT_PROFILE_IDS = Object.keys(AGENT_PROFILES) as AgentProfileId[];

export function isAgentProfileId(id: string): id is AgentProfileId {
  return Object.prototype.hasOwnProperty.call(AGENT_PROFILES, id);
}
