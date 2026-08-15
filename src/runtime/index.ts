// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Runtime registry. Selects the agent runtime by BIVY_RUNTIME (default "pi").
// This is the seam where additional runtimes (Claude Agent SDK, generic RPC,
// …) are registered without touching the daemon.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRuntime, claudeRuntimeFromEnv, claudeSdkInstalled, invalidateClaudeCliProbe } from "../agents/claude-code/runtime.js";
import { claudeCodeIntegration } from "../agents/claude-code/integration.js";
import {
  codexAppServerRuntime,
  codexIntegration,
  invalidateCodexCommandProbe,
} from "../agents/codex/integration.js";
import { invalidatePiCommandProbe, piAgentDir, piCommandAvailable, piIntegration } from "../agents/pi/integration.js";
import { deleteCodexSession, loadCodexTranscript } from "./codex-sessions.js";
import { deleteOpenCodeSession, exportOpenCodeSession, importOpenCodeSession, loadOpenCodeTranscript, writeOpenCodeHistory } from "./opencode-sessions.js";
import { discoverNativeGrokSessions, listGrokSessions, loadGrokTranscript } from "./grok-sessions.js";
import { createCredentialStore } from "./credentials.js";
import { AgentRegistry } from "../agents/registry.js";
import { applyCertification } from "../certification/index.js";
import {
  type AgentIntegration,
  type AgentIntegrationOrigin,
} from "../agents/definition.js";
import {
  AGENT_PROFILES,
  AGENT_PROFILE_IDS,
  isAgentProfileId,
  type AgentInstallDescriptor,
  type AgentProfile,
  type AgentProfileBehaviors,
  type AgentProfileId,
} from "../agents/profiles.js";

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
import type { ModelInfo, ForkHistoryMessage, ForkImportContext, ForkNativePayload } from "./types.js";
import { PiRuntime } from "../agents/pi/runtime.js";
import { ProcessRuntime, processRuntimeFromEnv, type ProcessModelConfig, type ProcessPromptMode, type ProcessThinkingConfig } from "./process.js";
import { codexCredentialPreflight } from "./codex-preflight.js";
import { opencodeCredentialPreflight } from "./opencode-preflight.js";
import { grokCredentialPreflight } from "./grok-preflight.js";
import { ensureGrokAuth } from "./grok-auth.js";
import { parserFactoryFor } from "./cli-parsers.js";
import { sandboxTier, sandboxArgsFor } from "../harness/sandbox.js";
import type { McpConfig } from "../harness/mcp-config.js";
import { serializeAcpMcpEnv } from "./acp-mcp.js";
import { ProtocolRuntime, protocolRuntimeFromEnv, protocolCommandsFromEnv, type ProtocolRuntimeOptions } from "./protocol.js";
import { codexSlashCommands, opencodeSlashCommands, type SlashCommandProvider } from "./slash-commands.js";
import { withExactCapabilitySurface, type AgentRuntime } from "./types.js";
import { installedAgentContributions } from "../plugins/store.js";
import { currentBivyVersion } from "../app-version.js";
import type {
  AgentAvailability,
  AgentCertification,
  AgentInfo,
  AgentInstallCommand,
  AgentInstallInfo,
  AgentProtectionLevel,
  AgentSessionOptions,
  AgentSupportTier,
} from "../agents/types.js";

/** Host behavior interpreters keyed by serializable profile values. Adding a
 * behavior implementation adds one row here; assigning it to an agent is data in
 * AGENT_PROFILES, so the generic wrapper never branches on agent identity. */
type PreflightBehavior = NonNullable<AgentProfileBehaviors["preflight"]>;
type SlashCommandsBehavior = NonNullable<AgentProfileBehaviors["slashCommands"]>;
const PREFLIGHT_BEHAVIORS: Record<PreflightBehavior, NonNullable<import("./process.js").ProcessRuntimeOptions["preflight"]>> = {
  codex: (env) => codexCredentialPreflight(env),
  opencode: (env, ctx) => opencodeCredentialPreflight(env, ctx),
  grok: (env) => grokCredentialPreflight(env),
};
const SLASH_COMMAND_BEHAVIORS: Record<SlashCommandsBehavior, () => SlashCommandProvider> = {
  codex: codexSlashCommands,
  opencode: opencodeSlashCommands,
};

function cliSlashCommands(spec: AgentProfile): SlashCommandProvider | undefined {
  const behavior = spec.behaviors?.slashCommands;
  return behavior ? SLASH_COMMAND_BEHAVIORS[behavior]() : undefined;
}

export * from "./types.js";
export { NodeCredentialResolver, createCredentialStore } from "./credentials.js";

// Compatibility names retained at the runtime API boundary while integrations
// move into src/agents and the UI/API migrate to agent terminology.
export type RuntimeFactoryOptions = AgentSessionOptions;
export type RuntimeStatus = AgentAvailability;
export type RuntimeSupportTier = AgentSupportTier;
export type RuntimeProtectionLevel = AgentProtectionLevel;
export type RuntimeCertification = AgentCertification;
export type RuntimeSource = AgentIntegrationOrigin;
export type RuntimeInstallInfo = AgentInstallInfo;
export type RuntimeInfo = AgentInfo;

// Memoized CLI probes. `commandAvailable`/`resolveCommandPath`/`probeHelpText`
// each shell out with a BLOCKING spawnSync, and the runtime catalog that calls
// them (cliAgentInfo → prefersAcp/acpSupportedByBinary) is rebuilt often — on
// every advertise and every runtimes.list send. Re-probing per build stalled the
// event loop for seconds at a time (a synchronous spawn storm). A CLI's presence
// is effectively constant for the daemon's run, so cache per command for the
// process lifetime and clear on install (invalidateCliProbeCache).
const COMMAND_AVAILABLE_CACHE = new Map<string, boolean>();
function commandAvailable(command: string): boolean {
  if (!command.trim()) return false;
  const cached = COMMAND_AVAILABLE_CACHE.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  const available = result.status === 0;
  COMMAND_AVAILABLE_CACHE.set(command, available);
  return available;
}

function genericCliInfo(): RuntimeInfo {
  const options = processRuntimeFromEnv();
  const configured = Boolean(options);
  // Same generic primitive as the maintained agent profiles: honest only when
  // BIVY_AGENT_RESUME_TEMPLATE actually wired resumeArgs (see processRuntimeFromEnv).
  const resume = Boolean(options?.resumeArgs);
  return {
    id: "generic-cli",
    executionMode: "pipe",
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

/** User-defined agents persisted through cli.json's env block. Custom entries
 * inherit a maintained profile and override only serializable launch metadata. */
type CustomAgentConfig = {
  id: string;
  label?: string;
  extends: AgentProfileId;
  command?: string;
  args?: string[];
  jsonArgs?: string[];
  parserId?: string;
  promptMode?: ProcessPromptMode;
  hidden?: boolean;
};

function customAgentSpecs(): Map<string, AgentProfile> {
  const out = new Map<string, AgentProfile>();
  const raw = process.env.BIVY_CUSTOM_AGENTS?.trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const item = value as Partial<CustomAgentConfig>;
      const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(id) || out.has(id)) continue;
      if (typeof item.extends !== "string" || !isAgentProfileId(item.extends)) continue;
      const base = AGENT_PROFILES[item.extends];
      const strings = (v: unknown): string[] | undefined => Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
      out.set(id, {
        ...base,
        displayName: typeof item.label === "string" && item.label.trim() ? item.label.trim() : id,
        command: typeof item.command === "string" && item.command.trim() ? item.command.trim() : base.command,
        ...(strings(item.args) ? { args: strings(item.args) } : {}),
        ...(strings(item.jsonArgs) ? { jsonArgs: strings(item.jsonArgs) } : {}),
        ...(typeof item.parserId === "string" ? { parserId: item.parserId } : {}),
        ...(item.promptMode === "stdin" || item.promptMode === "argv" ? { promptMode: item.promptMode } : {}),
        hidden: item.hidden === true,
        supportTier: "experimental",
        testedVersion: undefined,
        install: undefined,
        // `extends` reuses declarative launch syntax, never maintained host code.
        // A different executable must not inherit Codex/OpenCode/Grok credential,
        // store, slash-command, or native-discovery behavior by accident.
        behaviors: undefined,
        ...(base.resume ? { resume: { template: base.resume.template, ...(base.resume.newTemplate ? { newTemplate: base.resume.newTemplate } : {}) } } : {}),
      });
    }
  } catch {
    // Invalid operator configuration is ignored; packaged integrations remain usable.
  }
  return out;
}

export function pluginAgentConflictDiagnostics(dataDir?: string): string[] {
  const installed = installedAgentContributions(dataDir);
  const errors = [...installed.errors];
  for (const conflict of agentRegistry(dataDir).diagnostics()) {
    if (conflict.rejectedOrigin.kind !== "package" || conflict.rejectedOrigin.location !== "installed") continue;
    errors.push(`${conflict.rejectedOrigin.packageId}: agent id ${conflict.id} conflicts with ${conflict.retainedSource}`);
  }
  return errors;
}

type InstalledAgentContribution = ReturnType<typeof installedAgentContributions>["agents"][number];

/** Translate a public manifest contribution into the shared CLI adapter shape. */
function pluginAgentSpec(contribution: InstalledAgentContribution): AgentProfile {
  const { agent } = contribution;
  const common = {
    displayName: agent.name,
    command: agent.adapter.command,
    packageName: `${contribution.pluginName} plugin`,
    promptMode: "stdin" as ProcessPromptMode,
    hidden: agent.hidden === true,
    supportTier: "experimental" as RuntimeSupportTier,
    authOwner: agent.authOwner ?? "agent" as const,
    blurb: agent.description ?? `Agent contributed by ${contribution.pluginName}.`,
    install: undefined,
  };
  if (agent.adapter.kind === "acp") {
    return {
      ...common,
      args: [],
      acp: { args: agent.adapter.args ?? [], preferred: true, declared: true },
      protocolOnly: true,
    };
  }
  return {
    ...common,
    args: agent.adapter.args ?? [],
    promptMode: agent.adapter.promptMode ?? "stdin",
    ...(agent.adapter.structured
      ? { jsonArgs: agent.adapter.structured.args, parserId: agent.adapter.structured.parser }
      : {}),
    ...(agent.adapter.resume ? { resume: { template: agent.adapter.resume.args, ...(agent.adapter.resume.newArgs ? { newTemplate: agent.adapter.resume.newArgs } : {}) } } : {}),
    ...(agent.adapter.model
      ? {
          model: {
            flag: agent.adapter.model.flag,
            insertAt: agent.adapter.model.insertAt,
            models: agent.adapter.model.choices,
          },
        }
      : {}),
  };
}

/** Compatibility exports for the terminal manifest generator. */
export { AGENT_PROFILE_IDS as CLI_AGENT_IDS };
export function isCliAgentId(id: string): id is AgentProfileId {
  return isAgentProfileId(id);
}

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
function installSpecForCliAgent(spec: AgentProfile, prefix: string): { command: string; args: string[]; display: string } | undefined {
  const install = spec.install;
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

export function cliInstallSpec(id: string, prefix: string): { command: string; args: string[]; display: string } | undefined {
  return isAgentProfileId(id) ? installSpecForCliAgent(AGENT_PROFILES[id], prefix) : undefined;
}

/**
 * Serializable agent manifest — the identity/install/visibility subset of
 * AGENT_PROFILES with no functions, so it can be written to
 * `bin/agent-manifest.json` and consumed by the plain-JS terminal CLI
 * (`bin/bivy.mjs`) that can't import this TypeScript module. `scripts/
 * generate-agent-manifest.mjs` regenerates the JSON; a unit test asserts the file
 * is in sync so the two never drift.
 */
export function cliAgentManifest(): Array<{
  id: AgentProfileId;
  label: string;
  command: string;
  hidden: boolean;
  supportTier: RuntimeSupportTier;
  certification: RuntimeCertification;
  testedVersion?: string;
  headlessFlags: string[];
  install: AgentInstallDescriptor | null;
}> {
  return AGENT_PROFILE_IDS.map((id) => {
    const spec = AGENT_PROFILES[id];
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
      supportTier: spec.supportTier ?? "beta",
      certification: spec.testedVersion ? "release-tested" : (spec.supportTier ?? "beta") === "beta" ? "adapter-tested" : "unverified",
      ...(spec.testedVersion ? { testedVersion: spec.testedVersion } : {}),
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
function cliArgsOverride(id: string): string[] | undefined {
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
 * the profile's declared template. Returns undefined when the agent has no known
 * resume form — which keeps the catalog honest (resume reported off).
 */
function cliResumeTemplate(id: string, spec: AgentProfile): string[] | undefined {
  const raw = process.env[`BIVY_${id.toUpperCase()}_RESUME_TEMPLATE`]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to the spec default
    }
  }
  return spec.resume?.template;
}

/**
 * Resolve a CLI agent's selectable model list: `BIVY_<ID>_MODELS` (a JSON array of
 * `{id,name?,provider?}`) overrides the spec's curated defaults. Each entry is
 * normalized to a full ModelInfo (the id is the CLI's own model name). Returns an
 * empty list when the agent has no model config and no override.
 */
function cliModelList(id: string, spec: AgentProfile): ModelInfo[] {
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
function cliModelConfig(id: string, spec: AgentProfile): ProcessModelConfig | undefined {
  if (!spec.model) return undefined;
  const models = cliModelList(id, spec);
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
function cliUsageReporting(spec: AgentProfile): boolean {
  const parserId = process.env.BIVY_AGENT_PARSER || spec.parserId;
  return Boolean(parserId) && USAGE_PARSERS.has(parserId!) && process.env.BIVY_AGENT_STRUCTURED !== "0";
}

/**
 * Build the ProcessRuntime thinking config for a CLI agent, or undefined when it
 * has no reasoning-effort flag. `BIVY_<ID>_THINKING` (JSON
 * `{levels,template,insertAt?,default?}`) overrides/enables it for any agent.
 */
function cliThinkingConfig(id: string, spec: AgentProfile): ProcessThinkingConfig | undefined {
  let cfg = spec.thinking;
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
/**
 * Absolute path of a command on the current PATH, or null when it isn't there.
 * Used to key the help-probe cache: caching by the bare NAME would keep serving a
 * stale answer after the binary behind that name changed (a CLI upgraded or
 * installed while the daemon is running, or a different PATH entry winning).
 * Memoized per command (see COMMAND_AVAILABLE_CACHE) — it spawnSyncs, and is hit
 * on every catalog build.
 */
const COMMAND_PATH_CACHE = new Map<string, string | null>();
function resolveCommandPath(command: string): string | null {
  if (!command.trim()) return null;
  const cached = COMMAND_PATH_CACHE.get(command);
  if (cached !== undefined) return cached;
  const res = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    encoding: "utf8",
  });
  const resolved = res.status !== 0 ? null : ((res.stdout ?? "").split(/\r?\n/)[0]?.trim() || null);
  COMMAND_PATH_CACHE.set(command, resolved);
  return resolved;
}

const HELP_PROBE_CACHE = new Map<string, string | null>();
function probeHelpText(command: string): string | null {
  const key = resolveCommandPath(command) ?? command;
  if (HELP_PROBE_CACHE.has(key)) return HELP_PROBE_CACHE.get(key) ?? null;
  let text: string | null;
  try {
    const res = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 4000 });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    text = out.length > 20 ? out.toLowerCase() : null; // too-short output = not real help
  } catch {
    text = null;
  }
  HELP_PROBE_CACHE.set(key, text);
  return text;
}

/**
 * Drop every memoized CLI probe (availability, resolved path, --help text). These
 * probes shell out with a blocking spawnSync and are cached for the process
 * lifetime to keep the frequently-rebuilt runtime catalog off the event loop, so a
 * CLI installed/updated mid-run wouldn't otherwise be noticed until a restart.
 * Call this right after Bivy installs a runtime so the next catalog build re-probes
 * and reflects the new binary immediately.
 */
export function invalidateCliProbeCache(): void {
  COMMAND_AVAILABLE_CACHE.clear();
  COMMAND_PATH_CACHE.clear();
  HELP_PROBE_CACHE.clear();
  invalidatePiCommandProbe();
  invalidateClaudeCliProbe();
  invalidateCodexCommandProbe();
}

// A resume template mixes launch flags (`-p`, `--force`) with the resume-specific
// token(s) (`--resume`, `threads continue`, `-s`, `--restore`, …). Only the latter
// evidence resume support, so we match on those — otherwise a shared launch flag
// appearing in help would mask a genuinely-missing resume flag.
const RESUME_HINT = /resume|continue|restore|session|thread|^-s$|^-r$|^-c$|^--id$/i;
/** The resume-indicative flag/subcommand tokens of a resume template. */
function resumeTokensFor(id: string, spec: AgentProfile): string[] {
  const tmpl = cliResumeTemplate(id, spec) ?? [];
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

function cliAgentInfo(id: string, spec: AgentProfile): RuntimeInfo {
  const installed = commandAvailable(spec.command);
  const npmPrefix = process.env.BIVY_NPM_GLOBAL_PREFIX || "~/.local";
  const installCommand = installSpecForCliAgent(spec, npmPrefix);
  // Honesty invariant (see docs/agents-not-fully-supported.md): capabilities must
  // reflect what the ProcessRuntime path actually delivers, or the PWA renders a
  // picker that silently no-ops. These CLI adapters stream stdout (structured via
  // a CliParser when the agent has a validated JSON mode, else raw) and are
  // governed at the effect level (sandbox tier / FS-MCP-network channels), so
  // toolInterception + modelSelection stay false. resume is on only when the
  // agent has a known resume form (spec.resume or a BIVY_<ID>_RESUME_TEMPLATE
  // override) — Codex is the maintained example; the rest are fresh-process-per-
  // prompt until a resume template is wired.
  let resume = spec.behaviors?.sessionStore === "codex" || Boolean(cliResumeTemplate(id, spec));
  let modelSelection = Boolean(cliModelConfig(id, spec));
  const usageReporting = cliUsageReporting(spec);
  const structuredPref = process.env.BIVY_AGENT_STRUCTURED;
  const structuredAvailable = Boolean(process.env.BIVY_AGENT_PARSER || spec.parserId) && (!spec.parserUnverified || structuredPref === "1") && structuredPref !== "0";
  // When the agent is promoted to ACP (spec.acp + BIVY_<ID>_ACP / BIVY_PREFER_ACP),
  // it runs through the governed ProtocolRuntime — so it honestly gains per-tool
  // approvals and resume. Reflect that in the catalog the picker reads.
  const acpActive = prefersAcp(id, spec);
  // Catalog discovery must remain usable even when an operator has configured
  // an invalid mode. The actual launch path resolves strictly and reports the
  // actionable error; the picker falls back to the honest default here.
  let executionMode: Exclude<CliExecutionMode, "auto">;
  try {
    executionMode = resolveCliExecutionMode({ requested: requestedCliExecutionMode(id), protocolAvailable: Boolean(spec.acp), structuredAvailable, protocolPreferred: acpActive });
  } catch {
    executionMode = spec.protocolOnly ? "protocol" : structuredAvailable ? "structured-pipe" : "pipe";
  }
  if (acpActive) resume = true;
  // Opt-in self-healing: if the installed binary's --help doesn't evidence a
  // resume/model flag we advertise, downgrade it (never upgrade). Codex keeps its
  // native, separately-verified resume path, so it's exempt.
  if (process.env.BIVY_AGENT_PROBE === "1" && installed && spec.behaviors?.sessionStore !== "codex") {
    const help = probeHelpText(spec.command);
    if (help) {
      const refined = refineCapabilitiesFromHelp(help, { resume, modelSelection }, { resumeTokens: resumeTokensFor(id, spec), modelFlag: spec.model?.flag });
      resume = refined.resume;
      modelSelection = refined.modelSelection;
    }
  }
  return {
    id,
    executionMode,
    displayName: spec.displayName,
    description: spec.blurb ?? `Run the local ${spec.displayName} CLI underneath Bivy in the session workspace.`,
    status: installed ? "available" : "external",
    packageName: spec.packageName,
    language: "Process",
    // MCP tool calls are gated by real approvals when the proxy shim is enabled
    // (BIVY_MCP_PROXY) — an honest, narrower capability than full toolInterception
    // (it governs MCP tools, not the agent's native shell/edits). See
    // src/harness/mcp-inject.ts + governMcpCall in src/server.ts.
    capabilities: withExactCapabilitySurface({
      toolInterception: acpActive,
      mcpToolApprovals: acpActive || Boolean(process.env.BIVY_MCP_PROXY),
      modelSelection,
      resume,
      packages: false,
      fork: false,
      usageReporting,
      // Codex (and Grok) can locate an on-disk session by cwd + start time so a
      // `bivy run` terminal without a launch-time pin is still takeable as chat.
      sessionDiscovery: Boolean(spec.behaviors?.sessionStore === "codex" || spec.behaviors?.nativeSessions),
      // Native-session behavior identities describe discovery/adoption and TUI
      // hand-off without teaching the wrapper which concrete agent owns them.
      interactiveTui: Boolean(spec.behaviors?.nativeSessions) && commandAvailable(spec.command),
      nativeSessionDiscovery: Boolean(spec.behaviors?.nativeSessions) && commandAvailable(spec.command),
      nativeSessionAdoption: Boolean(spec.behaviors?.nativeSessions) && resume,
    }),
    nativeSandbox: Boolean(spec.nativeSandbox),
    supportTier: spec.supportTier ?? "experimental",
    testedVersion: spec.testedVersion,
    authOwner: spec.authOwner ?? "agent",
    notes: installed
      ? acpActive
        // Promoted to ACP: the description must match the governed path actually in
        // use, not the pipe path this agent would otherwise take.
        ? `Available on PATH, driven through its Agent Client Protocol server (\`${spec.command} ${spec.acp?.args.join(" ")}\`): blocking permission requests are gated by Bivy's Approve/Deny, already-running activity is observed, and sessions resume natively. Force the plain stdout pipe with BIVY_${id.toUpperCase()}_ACP=0.`
        : `Available on PATH. This process adapter ${spec.parserId && !spec.parserUnverified ? "parses its native JSON stream into a structured transcript" : spec.parserId ? "streams stdout/stderr (a structured JSON parser is available; opt in with BIVY_AGENT_STRUCTURED=1 once validated for your version)" : "streams stdout/stderr"}; Bivy governs its filesystem/exec/MCP effects at the sandbox tier rather than intercepting each tool call. Override its launch flags with BIVY_${id.toUpperCase()}_ARGS if your CLI version differs.`
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
/**
 * The Codex CLI release this adapter was last certified against. Unlike Pi and the
 * Claude Agent SDK, Codex is an external binary rather than a pinned npm dependency,
 * so there is no lockfile entry to derive this from — it is bumped deliberately when
 * the app-server shim is re-validated against a new Codex release.
 */
/**
 * Catalog-capable runtimes for the unified model catalog — Pi included as one
 * contributor among equals, not a privileged base. Each runtime's `listCatalog()`
 * contributes its providers + models, deduped and stamped with the shared vault's
 * auth status by `aggregateModelCatalog`. Construction is cheap (no session
 * spawned); listCatalog() is static. Codex is always listed; Claude Code when the
 * operator's CLI and its protocol bridge are both available.
 */
export function catalogRuntimes(credsDir: string, piDir: string, sessionsDir: string): AgentRuntime[] {
  const runtimes: AgentRuntime[] = [codexAppServerRuntime()];
  // Credentials come from Bivy's shared vault (credsDir), not Pi's plaintext
  // auth.json: the daemon signs in once and every agent reuses it. The agent dir
  // (piAgentDir) still supplies the operator's models cache / config / packages.
  // credentialOwner "agent" here would make Pi read piAgentDir/auth.json — a file
  // the vault never populates — so the picker shows every provider "Not connected".
  if (piCommandAvailable()) runtimes.unshift(new PiRuntime({ credsDir, piDir: piAgentDir(), sessionsDir, credentialOwner: "bivy" }));
  const claudeOptions = claudeRuntimeFromEnv();
  if (claudeSdkInstalled() && claudeOptions.executablePath) runtimes.push(new ClaudeCodeRuntime(claudeOptions));
  return runtimes;
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
function acpRuntimeOptions(opts: { id: string; displayName: string; command: string; agentArgs: string[]; credsDir?: string; behaviors?: AgentProfileBehaviors; mcpConfig?: McpConfig; sandbox?: AgentSessionOptions["sandbox"] }): ProtocolRuntimeOptions {
  const slashBehavior = opts.behaviors?.slashCommands;
  const slashCommands = slashBehavior ? SLASH_COMMAND_BEHAVIORS[slashBehavior]() : undefined;
  // Forward Bivy's configured MCP servers to the ACP agent (3A): the shim reads
  // BIVY_ACP_MCP_SERVERS and advertises them on session/new — previously it sent
  // [], so ACP agents couldn't reach MCP (including Bivy's own tools server).
  const acpMcpEnv = serializeAcpMcpEnv(opts.mcpConfig);
  return {
    id: opts.id,
    displayName: opts.displayName,
    command: process.execPath,
    args: [acpShimPath(), "--agent", opts.command, "--", ...opts.agentArgs],
    // Seed governed+resumable up front so the daemon attaches guardianInterceptor to
    // the FIRST session (before the shim's hello lands); the hello confirms them.
    capabilities: { toolInterception: true, resume: true },
    resumable: true,
    env: {
      BIVY_ACP_SANDBOX: sandboxTier(opts.sandbox),
      ...(acpMcpEnv ? { BIVY_ACP_MCP_SERVERS: acpMcpEnv } : {}),
    },
    // An ACP-promoted opencode still surfaces/expands its on-disk commands (the
    // ACP handshake doesn't carry them); a bare ACP agent has none.
    ...(slashCommands ? { slashCommands } : {}),
    ...(opts.credsDir ? { credentials: createCredentialStore(opts.credsDir) } : {}),
    // OpenCode's own store is SQLite under $XDG_DATA_HOME, so an ACP-promoted
    // opencode can both read a resumed session's transcript back for history
    // preload (loadHistory), drop it on delete (deleteHistory), and — the fork
    // win — materialise a cross-runtime fork's portable history as a REAL session
    // in that store (writeHistory → capabilities.forkHistoryImport → fidelity
    // "replayed" instead of a seeded summary prompt). Only opencode has this
    // layout; a bare ACP agent gets none of these hooks.
    ...(opts.behaviors?.sessionStore === "opencode"
      ? {
          loadHistory: (sessionRef: string) => loadOpenCodeTranscript(sessionRef),
          deleteHistory: (sessionRef: string) => void deleteOpenCodeSession(sessionRef),
          writeHistory: (history: ForkHistoryMessage[], ctx: ForkImportContext) => writeOpenCodeHistory(history, ctx),
          // Native same-runtime fork transport (fidelity "full"): clone the
          // session/message/part rows so an opencode→opencode fork keeps each
          // message's full data, not a one-text-part-per-turn summary.
          exportForFork: (sessionRef: string) => exportOpenCodeSession(sessionRef),
          importForFork: (payload: ForkNativePayload, ctx: ForkImportContext) => importOpenCodeSession(payload, ctx),
        }
      : {}),
  };
}

function acpRuntimeFromEnv(credsDir?: string, sandbox?: AgentSessionOptions["sandbox"], mcpConfig?: McpConfig): ProtocolRuntimeOptions | null {
  const command = process.env.BIVY_ACP_COMMAND?.trim();
  if (!command) return null;
  let agentArgs: string[] = [];
  const rawArgs = process.env.BIVY_ACP_ARGS?.trim();
  if (rawArgs) {
    try { const p = JSON.parse(rawArgs); if (Array.isArray(p)) agentArgs = p.map(String); } catch { /* ignore malformed */ }
  }
  return acpRuntimeOptions({ id: "acp", displayName: process.env.BIVY_ACP_NAME?.trim() || "ACP Agent", command, agentArgs, credsDir, sandbox, mcpConfig });
}

/**
 * Does the INSTALLED binary actually evidence the agent's ACP mode? A default-on
 * promotion must never be taken on faith: ACP is a hard switch (the pipe path is
 * unreachable once a session opens), so a CLI too old to have the subcommand would
 * otherwise hang and die instead of degrading. We reuse the same cached `--help`
 * probe the opt-in capability refinement uses, and fail CLOSED — a missing binary
 * or unreadable help keeps the agent on the honest pipe path.
 */
function acpSupportedByBinary(spec: AgentProfile): boolean {
  if (!spec.acp) return false;
  if (!commandAvailable(spec.command)) return false;
  const help = probeHelpText(spec.command);
  if (!help) return false;
  const token = (spec.acp.helpToken ?? spec.acp.args[0] ?? "acp").toLowerCase();
  return help.includes(token);
}

/**
 * Whether a CLI agent should be driven through ACP rather than the one-shot pipe.
 * Three ways in, in precedence order:
 *   - `BIVY_<ID>_ACP=0` — operator forces the pipe path back (escape hatch).
 *   - `BIVY_<ID>_ACP=1` / `BIVY_PREFER_ACP=1` — operator forces ACP, no probe (they
 *     know their binary; an explicit request shouldn't be second-guessed).
 *   - `spec.acp.preferred` — validated agents are promoted by DEFAULT, but only
 *     when the installed binary evidences the ACP mode (see acpSupportedByBinary).
 * Still no per-agent code: a spec field plus a flag.
 *
 * Both the catalog (cliAgentInfo) and the launch path (makeCliRuntime) call this,
 * so what the picker advertises and what actually starts cannot disagree.
 */
function prefersAcp(id: string, spec: AgentProfile): boolean {
  if (!spec.acp) return false;
  // Installing an ACP plugin is itself the operator's explicit declaration that
  // this command speaks ACP. Unlike a catalog profile promotion, it has no pipe mode to
  // probe or fall back to.
  if (spec.acp.declared) return true;
  const override = process.env[`BIVY_${id.toUpperCase()}_ACP`];
  if (override === "0") return false;
  if (override === "1" || process.env.BIVY_PREFER_ACP === "1") return true;
  if (!spec.acp.preferred) return false;
  return acpSupportedByBinary(spec);
}

export type CliExecutionMode = "auto" | "protocol" | "structured-pipe" | "pipe" | "pty";

/**
 * Resolve the communication mode for a CLI agent. This is deliberately pure so
 * it can be tested without starting a process. PTY is a terminal-launch mode,
 * not a governed ProcessRuntime mode; callers must handle it explicitly.
 */
export function resolveCliExecutionMode(input: {
  requested?: string;
  protocolAvailable: boolean;
  structuredAvailable: boolean;
  protocolPreferred?: boolean;
}): Exclude<CliExecutionMode, "auto"> {
  const raw = input.requested?.trim().toLowerCase() || "auto";
  const requested = (raw === "structured" ? "structured-pipe" : raw) as CliExecutionMode;
  if (!["auto", "protocol", "structured-pipe", "pipe", "pty"].includes(requested)) {
    throw new Error(`Invalid agent execution mode "${input.requested}". Use auto, protocol, structured-pipe, pipe, or pty.`);
  }
  if (requested === "pty") return "pty";
  if (requested === "protocol") {
    if (!input.protocolAvailable) throw new Error("Protocol execution was requested, but this agent has no configured protocol adapter.");
    return "protocol";
  }
  if (requested === "structured-pipe") {
    if (!input.structuredAvailable) throw new Error("Structured pipe execution was requested, but this agent has no available structured parser.");
    return "structured-pipe";
  }
  if (requested === "pipe") return "pipe";
  if (input.protocolAvailable && input.protocolPreferred) return "protocol";
  if (input.structuredAvailable) return "structured-pipe";
  return "pipe";
}

function requestedCliExecutionMode(id: string): string | undefined {
  return process.env[`BIVY_${id.toUpperCase()}_MODE`] ?? process.env.BIVY_AGENT_MODE;
}

function acpInfo(): RuntimeInfo {
  const configured = Boolean(process.env.BIVY_ACP_COMMAND?.trim());
  return {
    id: "acp",
    executionMode: "protocol",
    displayName: process.env.BIVY_ACP_NAME?.trim() || "ACP Agent",
    description: "Any Agent Client Protocol (ACP) agent, driven through Bivy's shim for permission-request approvals, observed activity, streaming, and resume.",
    status: configured ? "available" : "planned",
    packageName: process.env.BIVY_ACP_COMMAND?.trim() || "Set BIVY_ACP_COMMAND",
    language: "Process",
    capabilities: { toolInterception: true, modelSelection: false, resume: true, packages: false, fork: false },
    supportTier: "experimental",
    authOwner: "agent",
    notes: configured
      ? "Drives an ACP agent via bin/acp-shim.mjs → ProtocolRuntime: Approve/Deny for blocking permission requests, observed activity, streaming transcript, and session/load resume — no per-agent code. Validate against your agent, then promote it into the picker as data."
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
    executionMode: "pipe",
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
    executionMode: "protocol",
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

const AGENT_CATALOG_INFOS: RuntimeInfo[] = [
  genericCliInfo(),
  // `codex` sits before the governed shim it feeds; the rest of the CLI agents are
  // derived straight from AGENT_PROFILES (adding a spec = one data edit, no list
  // to keep in sync here).
  cliAgentInfo("codex", AGENT_PROFILES.codex),
  ...AGENT_PROFILE_IDS.filter((id) => id !== "codex").map((id) => cliAgentInfo(id, AGENT_PROFILES[id])),
  openClawInfo(),
  protocolInfo(),
  acpInfo(),
];

// Agents Bivy fully integrates today and therefore shows in the agent picker —
// the most-used coding agents, all driven through generic integration paths (the
// Pi/Claude bridges, the Codex app-server bridge, and the data-driven CLI
// ProcessRuntime + CliParser path) rather than bespoke per-agent code:
//
//   pi, claude-code-sdk         — richer bridges (approvals, models, resume)
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
// Everything else in the agent catalog is an integration hook that works once
// configured via env (generic-cli, bivy-agent-protocol) or a lower-fidelity
// profile (hermes, openclaw). Hidden profiles remain runnable via
// `BIVY_RUNTIME=<id>`. To promote a CLI agent into the picker, give it honest
// capabilities (no silently-no-op pickers) and drop its `hidden: true` flag in
// AGENT_PROFILES — the picker set below derives from that one field.
// See docs/agents-not-fully-supported.md for the rationale and the promotion path.
//
// The picker = the native/shim runtimes that aren't CLI-agent specs, PLUS every
// non-hidden CLI agent. Visibility lives on the spec (`hidden`), so promoting or
// demoting an agent is a single data edit with no id list to drift.
type RuntimeRegistration = AgentIntegration<RuntimeInfo, RuntimeFactoryOptions, AgentRuntime, AgentInstallCommand>;
const BIVY_AGENT_INTEGRATIONS_ORIGIN: AgentIntegrationOrigin = {
  kind: "package",
  packageId: "bivy-agent-integrations",
  packageVersion: currentBivyVersion(),
  publisher: "Bivy",
  location: "distribution",
  verified: true,
};

const AGENT_ALIASES: Record<string, string[]> = {
  opencode: ["open-code"],
  gemini: ["gemini-cli"],
  qwen: ["qwen-code"],
  openclaw: ["open-claw"],
};

function describeCatalogAgent(base: RuntimeInfo): RuntimeInfo {
  const id = base.id;
  const info = id === "generic-cli"
      ? genericCliInfo()
      : id === "openclaw"
          ? openClawInfo()
          : id === "bivy-agent-protocol"
              ? protocolInfo()
              : id === "acp"
                ? acpInfo()
                : base;
  return { ...info, source: BIVY_AGENT_INTEGRATIONS_ORIGIN };
}

function catalogInstallCommand(id: string, prefix: string): AgentInstallCommand | undefined {
  if (isAgentProfileId(id)) return cliInstallSpec(id, prefix);
  if (id === "openclaw") {
    return {
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, "openclaw"],
      display: `npm install --global --prefix ${prefix} openclaw`,
    };
  }
  return undefined;
}

function cliRegistration(id: string, spec: AgentProfile, origin: AgentIntegrationOrigin): RuntimeRegistration {
  return {
    id,
    visible: !spec.hidden,
    origin,
    describe: () => ({ ...cliAgentInfo(id, spec), source: origin }),
    create: (options) => makeCliRuntime(id, options, spec),
    ...(spec.install ? { install: (prefix: string) => installSpecForCliAgent(spec, prefix) } : {}),
  };
}

/** Build the one authoritative registry in precedence order. */
function agentRegistry(pluginDataDir?: string): AgentRegistry<RuntimeInfo, RuntimeFactoryOptions, AgentRuntime, AgentInstallCommand> {
  const registry = new AgentRegistry<RuntimeInfo, RuntimeFactoryOptions, AgentRuntime, AgentInstallCommand>();

  // Rich integrations own their complete description/connection hooks in their
  // agent folders. Declarative profiles below use the shared process/ACP hosts.
  registry.register(piIntegration(BIVY_AGENT_INTEGRATIONS_ORIGIN));
  registry.register(claudeCodeIntegration(BIVY_AGENT_INTEGRATIONS_ORIGIN));
  registry.register(codexIntegration(BIVY_AGENT_INTEGRATIONS_ORIGIN));

  for (const base of AGENT_CATALOG_INFOS) {
    const id = base.id;
    const cli = isAgentProfileId(id) ? AGENT_PROFILES[id] : undefined;
    registry.register({
      id,
      ...(AGENT_ALIASES[id] ? { aliases: AGENT_ALIASES[id] } : {}),
      visible: cli ? !cli.hidden : false,
      origin: BIVY_AGENT_INTEGRATIONS_ORIGIN,
      describe: () => cli ? { ...cliAgentInfo(id, cli), source: BIVY_AGENT_INTEGRATIONS_ORIGIN } : describeCatalogAgent(base),
      ...(base.supportTier !== "planned"
        ? { create: (options: RuntimeFactoryOptions) => cli ? makeCliRuntime(id, options, cli) : createCatalogRuntime(id, options) }
        : {}),
      ...(catalogInstallCommand(id, process.env.BIVY_NPM_GLOBAL_PREFIX || "~/.local")
        ? { install: (prefix: string) => catalogInstallCommand(id, prefix) }
        : {}),
    });
  }

  // Machine configuration and installed packages use the exact same lifecycle.
  // Earlier registrations win, and every retained/rejected origin remains explicit.
  for (const [id, spec] of customAgentSpecs()) registry.register(cliRegistration(id, spec, { kind: "config" }));
  for (const contribution of installedAgentContributions(pluginDataDir).agents) {
    registry.register(cliRegistration(contribution.agent.id, pluginAgentSpec(contribution), {
      kind: "package",
      packageId: contribution.pluginId,
      packageVersion: contribution.pluginVersion,
      location: "installed",
      verified: false,
    }));
  }
  return registry;
}

/** All registered contributions, including hidden/planned rows, for diagnostics. */
export function listRegisteredAgents(): RuntimeInfo[] {
  return agentRegistry().list().map((entry) => applyCertification(entry.describe()));
}

/** Resolve an id or historical alias through the authoritative registry. */
export function canonicalAgentId(id: string): string | undefined {
  return agentRegistry().get(id.toLowerCase())?.id;
}

/** Resolve an allowlisted installer from the same registration the picker uses. */
export function agentInstallSpec(id: string, prefix: string): AgentInstallCommand | undefined {
  return agentRegistry().get(id.toLowerCase())?.install?.(prefix);
}

function runtimeCertification(runtime: RuntimeInfo): Pick<RuntimeInfo, "certification" | "testedVersion"> {
  if (runtime.certification) return {
    certification: runtime.certification,
    ...(runtime.testedVersion ? { testedVersion: runtime.testedVersion } : {}),
  };
  if (runtime.testedVersion) return { certification: "release-tested", testedVersion: runtime.testedVersion };
  return { certification: runtime.supportTier === "beta" ? "adapter-tested" : "unverified" };
}

function runtimeProtection(runtime: RuntimeInfo): Pick<RuntimeInfo, "protectionLevel" | "protectionLabel" | "protectionDetail"> {
  // Native SDK/CLI sandboxes receive the requested read-only/workspace/full tier
  // in their own process boundary. The governed Codex path has both native
  // sandbox flags and Bivy interception; label the stronger containment source.
  if (runtime.nativeSandbox) return {
    protectionLevel: "native-sandbox",
    protectionLabel: "Native sandbox",
    protectionDetail: "This agent enforces Bivy's selected access tier in its native sandbox. Bivy tool controls may add approvals, but are not an OS jail of their own.",
  };
  if (runtime.capabilities.toolInterception) return {
    protectionLevel: "tool-controls",
    protectionLabel: "Bivy tool controls",
    protectionDetail: "Structured tool calls pass through Bivy policy and approvals. Shell heuristics prevent accidents, not adversarial escape.",
  };
  if (runtime.capabilities.mcpToolApprovals) return {
    protectionLevel: "mcp-controls",
    protectionLabel: "MCP tools only",
    protectionDetail: "Bivy governs MCP tool calls, but the agent's built-in shell and file operations still run with your user permissions.",
  };
  return {
    protectionLevel: "user-permissions",
    protectionLabel: "Runs as your user",
    protectionDetail: "No Bivy-owned isolation or complete tool interception. Use a container/VM for unattended or untrusted work.",
  };
}

export function listRuntimes(currentId?: string): (RuntimeInfo & { current: boolean })[] {
  const registry = agentRegistry();
  const selected = currentId ? registry.get(currentId.toLowerCase())?.id : undefined;
  return registry.list()
    // Keep the current runtime visible even if hidden, so a session pinned to a
    // hidden contribution still renders its selection instead of an empty picker.
    .filter((entry) => entry.visible || entry.id === selected)
    .map((entry) => applyCertification(entry.describe()))
    .map((runtime) => ({
      ...runtime,
      ...runtimeProtection(runtime),
      ...runtimeCertification(runtime),
      current: runtime.id === selected,
    }));
}

function createCatalogRuntime(id: string, options: RuntimeFactoryOptions): AgentRuntime {
  switch (id) {
    case "generic-cli": {
      const processOptions = processRuntimeFromEnv();
      if (!processOptions) throw new Error("generic-cli requires BIVY_AGENT_COMMAND to be set.");
      // Share the node's provider logins (the shared vault) so the CLI agent finds
      // whatever model key it needs without a separate per-agent sign-in.
      // BIVY_AGENT_PARSER opts this agent into Phase 4 structured mode (fidelity).
      return new ProcessRuntime({ ...processOptions, parserFactory: parserFactoryFor(process.env.BIVY_AGENT_PARSER) });
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
      const acpOptions = acpRuntimeFromEnv(options.credsDir, options.sandbox, options.mcpConfig);
      if (!acpOptions) throw new Error("acp requires BIVY_ACP_COMMAND to be set (the ACP agent's launch command, e.g. gemini).");
      return new ProtocolRuntime(acpOptions);
    }
    default:
      throw new Error(`Agent integration "${id}" has no connection implementation.`);
  }
}

/** Resolve every packaged or configured agent integration through one registry. */
export function makeRuntime(options: RuntimeFactoryOptions): AgentRuntime {
  const requested = (options.runtime ?? process.env.BIVY_RUNTIME ?? "pi").toLowerCase();
  const registry = agentRegistry();
  const registration = registry.get(requested);
  if (!registration?.create) {
    const available = registry.list().filter((entry) => Boolean(entry.create)).map((entry) => entry.id).join(", ");
    throw new Error(`Unknown or unavailable BIVY_RUNTIME "${requested}". Registered runtimes: ${available}`);
  }
  return registration.create({ ...options, runtime: registration.id });
}

/**
 * Build a ProcessRuntime for any CLI agent from its AGENT_PROFILES entry — the
 * single data-driven launch path (structured JSON mode where a parser exists,
 * effect-level governance, generic resume). Extracted from the makeRuntime switch
 * so adding an agent stays a pure-data change.
 */
function makeCliRuntime(id: string, options: RuntimeFactoryOptions, spec: AgentProfile): AgentRuntime {
      if (!commandAvailable(spec.command)) throw new Error(`${spec.displayName} command not found on PATH: ${spec.command}`);
      const behaviors = spec.behaviors;
      // Resolve the mode before launching anything. ACP and structured parsing
      // remain data-driven; explicit mode overrides are fail-closed rather than
      // silently degrading to a less capable path.
      const structuredPref = process.env.BIVY_AGENT_STRUCTURED;
      const structuredAvailable = Boolean(process.env.BIVY_AGENT_PARSER || spec.parserId) && (!spec.parserUnverified || structuredPref === "1") && structuredPref !== "0";
      const executionMode = resolveCliExecutionMode({
        requested: requestedCliExecutionMode(id),
        protocolAvailable: Boolean(spec.acp),
        structuredAvailable,
        protocolPreferred: prefersAcp(id, spec),
      });
      if (spec.protocolOnly && executionMode !== "protocol") {
        throw new Error(`${spec.displayName} is an ACP-only plugin agent; execution mode ${executionMode} is unavailable.`);
      }
      if (executionMode === "pty") {
        throw new Error(`PTY mode is for interactive terminal launches. Use 'bivy run ${spec.command}' instead of a governed chat session.`);
      }
      if (executionMode === "protocol") {
        if (!spec.acp) throw new Error(`${spec.displayName} does not declare an ACP/protocol launch mode.`);
        return new ProtocolRuntime(acpRuntimeOptions({
          id,
          displayName: spec.displayName,
          command: spec.command,
          agentArgs: spec.acp.args,
          behaviors: spec.behaviors,
          ...(spec.authOwner && spec.authOwner !== "agent" ? { credsDir: options.credsDir } : {}),
          sandbox: options.sandbox,
          mcpConfig: options.mcpConfig,
        }));
      }
      const structured = executionMode === "structured-pipe";
      const parserId = process.env.BIVY_AGENT_PARSER || (structured ? spec.parserId : undefined);
      const tier = sandboxTier(options.sandbox);
      // Operators may override the launch recipe for an unpinned CLI version;
      // otherwise interpret the profile's immutable argument data.
      const baseArgs = structured && spec.jsonArgs ? spec.jsonArgs : spec.args;
      const runArgs = cliArgsOverride(id) ?? (() => {
        if (!spec.nativeSandbox) return baseArgs;
        const base = [...(baseArgs ?? [])];
        const sandboxArgs = spec.nativeSandbox.argsByTier[tier];
        const declared = spec.nativeSandbox.insertAt;
        const index = declared === undefined
          ? base.length
          : declared < 0
            ? Math.max(0, base.length + declared)
            : Math.min(base.length, declared);
        return [...base.slice(0, index), ...sandboxArgs, ...base.slice(index)];
      })();
      // Preflights validate the agent's own login. Grok explicitly declares
      // mixed auth and may materialize a Bivy-connected subscription; Codex and
      // OpenCode retain their native stores without credential replacement.
      const preflight = behaviors?.preflight ? PREFLIGHT_BEHAVIORS[behaviors.preflight] : undefined;
      const prepare = behaviors?.prepare === "grok-auth"
        ? async (): Promise<Record<string, string>> => {
            const home = await ensureGrokAuth(options.credsDir);
            return home ? { GROK_HOME: home } : {};
          }
        : undefined;
      // Resume, the generic way. Codex keeps its verified path (rollout history +
      // tier-aware `codex exec resume <id> --json`). Every other CLI agent becomes
      // resumable purely as data: a spec.resume template (or a BIVY_<ID>_RESUME_
      // TEMPLATE override) whose {id}/{tier}/{sandbox} placeholders are filled per
      // prompt — no per-agent code. Absent = fresh process per prompt (resume
      // stays off; see the per-agent comments in AGENT_PROFILES for why some
      // genuinely have no native "continue session <id>" form).
      const codexStore = behaviors?.sessionStore === "codex";
      const resumeTemplate = codexStore ? undefined : cliResumeTemplate(id, spec);
      const resumeOpts = codexStore
        ? {
            resumable: true,
            loadHistory: (sessionId: string) => loadCodexTranscript(sessionId),
            deleteHistory: (sessionId: string) => void deleteCodexSession(sessionId),
            resumeArgs: (sessionId: string) => codexResumeArgs(sessionId, tier),
          }
        : resumeTemplate
          ? {
              resumable: true,
              loadHistory: spec.resume?.historyLoader === "grok" ? loadGrokTranscript : undefined,
              // `{sandbox}` expands to that agent's native containment flags for
              // the tier (e.g. Gemini/Qwen's `--approval-mode <mode>`) — a whole
              // token, not a string substitution, since it can be multiple argv
              // words; `{id}`/`{tier}` stay plain per-token string replacement.
              ...(spec.resume?.newTemplate
                ? {
                    newSessionArgs: (sessionId: string) =>
                      spec.resume!.newTemplate!.flatMap((a) =>
                        a === "{sandbox}"
                          ? sandboxArgsFor(id, tier)
                          : [a.replace(/\{id\}/g, sessionId).replace(/\{tier\}/g, tier)],
                      ),
                  }
                : {}),
              resumeArgs: (sessionId: string) =>
                resumeTemplate.flatMap((a) =>
                  a === "{sandbox}"
                    ? sandboxArgsFor(id, tier)
                    : [a.replace(/\{id\}/g, sessionId).replace(/\{tier\}/g, tier)],
                ),
            }
          : {};
      // Grok-specific: on-disk session enumeration + interactive TUI hand-off so
      // `bivy run grok` sessions persist after the PTY exits and can be taken
      // over as chat or reopened in the native TUI.
      const nativeSessionOpts =
        behaviors?.nativeSessions === "grok"
          ? {
              sessionDiscovery: true,
              listDiskSessions: () =>
                listGrokSessions().map((s) => ({
                  id: s.id,
                  path: s.dir,
                  cwd: s.cwd,
                  name: s.name || s.firstMessage,
                  created: s.createdAt ? new Date(s.createdAt).toISOString() : undefined,
                  modified: s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined,
                  firstMessage: s.firstMessage,
                })),
              interactiveTui: ({ sessionRef, env }: { sessionRef?: string; cwd: string; env: Record<string, string> }) =>
                sessionRef ? { command: "grok", args: ["--resume", sessionRef], env } : null,
              // discoverNativeSessions is on AgentRuntime; ProcessRuntime doesn't
              // expose it as an option — wire via a thin subclass below when needed.
            }
          : {};
      const runtime = new ProcessRuntime({
        id,
        displayName: spec.displayName,
        command: spec.command,
        args: runArgs,
        promptMode: spec.promptMode,
        ...(spec.authOwner && spec.authOwner !== "agent" ? { credentials: createCredentialStore(options.credsDir) } : {}),
        parserFactory: parserFactoryFor(parserId),
        preflight,
        prepare,
        model: cliModelConfig(id, spec),
        thinking: cliThinkingConfig(id, spec),
        usageReporting: cliUsageReporting(spec),
        slashCommands: cliSlashCommands(spec),
        ...resumeOpts,
        ...nativeSessionOpts,
      });
      if (behaviors?.nativeSessions === "grok") {
        // Issue #156 discovery surface — ProcessRuntime has no options hook for
        // this; attach it so collectDiscoveredSessions picks Grok sessions up.
        (runtime as AgentRuntime).discoverNativeSessions = () => discoverNativeGrokSessions();
      }
      return runtime;
}
