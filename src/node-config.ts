// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** Typed, user-authored node configuration (`<data-dir>/config.yaml`). */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const NODE_CONFIG_FILE = "config.yaml";
export const NODE_CONFIG_VERSION = 1 as const;

export type ConfigSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type ConfigApproval = "never" | "risky" | "always" | "autonomous";

export interface NodeConfig {
  version: 1;
  node?: {
    workspace?: string;
    port?: number;
    maxConcurrentAutomations?: number;
  };
  defaults?: {
    agent?: string;
    model?: { provider: string; id: string } | null;
    sandbox?: ConfigSandbox;
    approval?: ConfigApproval;
  };
  /** Machine-wide safety floors that per-run and automation choices cannot weaken. */
  safety?: {
    maxSandbox?: ConfigSandbox;
    approvalFloor?: "risky" | "always";
  };
  sessions?: {
    sync?: boolean;
    worktreeSync?: boolean;
    standbyNodeId?: string;
    resume?: "auto" | "manual";
    autoAttachToolImages?: boolean;
    /** Minutes a turn may keep streaming raw tool output without any structural
     * progress (a tool completing, model text, a turn boundary) before the
     * watchdog treats it as wedged and recovers it. Bounds a chatty-but-hung tool
     * (e.g. an npm install retrying forever) that the silence stall never sees.
     * Default 15; 0 relies on the silence stall + wall-clock cap alone. */
    wedgedTurnMinutes?: number;
  };
  github?: { issuePrompt?: string };
  automation?: {
    checks?: string[];
    checkTimeoutMinutes?: number;
  };
  agents?: Record<string, {
    extends: string;
    label?: string;
    command?: string;
    args?: string[];
    jsonArgs?: string[];
    parserId?: string;
    promptMode?: "stdin" | "argv";
    hidden?: boolean;
  }>;
  /** Advanced/deployment overrides. Values remain strings, matching process.env. */
  environment?: Record<string, string>;
}

export interface NodeConfigResult {
  ok: boolean;
  config?: NodeConfig;
  errors: string[];
  warnings: string[];
}

const ROOT_KEYS = ["version", "node", "defaults", "safety", "sessions", "github", "automation", "agents", "environment"];
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVALS = new Set(["never", "risky", "always", "autonomous"]);
const SCRIPT_RE = /^[\w:.-]+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function unknownKeys(o: Record<string, unknown>, allowed: string[], at: string, errors: string[]) {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) errors.push(`${at}.${key} is not supported`);
}
function section(root: Record<string, unknown>, name: string, allowed: string[], errors: string[]): Record<string, unknown> {
  if (root[name] === undefined) return {};
  const out = record(root[name]);
  if (!out) { errors.push(`${name} must be an object`); return {}; }
  unknownKeys(out, allowed, name, errors);
  return out;
}
function optionalString(value: unknown, at: string, errors: string[], max = 4096): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) { errors.push(`${at} must be a non-empty string of at most ${max} characters`); return undefined; }
  return value.trim();
}
function optionalBoolean(value: unknown, at: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") { errors.push(`${at} must be true or false`); return undefined; }
  return value;
}
function optionalInteger(value: unknown, at: string, errors: string[], min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) { errors.push(`${at} must be an integer from ${min} to ${max}`); return undefined; }
  return Number(value);
}

export function validateNodeConfig(value: unknown): NodeConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = record(value);
  if (!root) return { ok: false, errors: ["configuration must be an object"], warnings };
  unknownKeys(root, ROOT_KEYS, "config", errors);
  if (root.version !== 1) errors.push("version must be 1");
  const node = section(root, "node", ["workspace", "port", "maxConcurrentAutomations"], errors);
  const defaults = section(root, "defaults", ["agent", "model", "sandbox", "approval"], errors);
  const safety = section(root, "safety", ["maxSandbox", "approvalFloor"], errors);
  const sessions = section(root, "sessions", ["sync", "worktreeSync", "standbyNodeId", "resume", "autoAttachToolImages", "wedgedTurnMinutes"], errors);
  const github = section(root, "github", ["issuePrompt"], errors);
  const automation = section(root, "automation", ["checks", "checkTimeoutMinutes"], errors);
  const agentsRaw = section(root, "agents", Object.keys(record(root.agents) ?? {}), errors);
  const environment = section(root, "environment", Object.keys(record(root.environment) ?? {}), errors);

  const workspace = optionalString(node.workspace, "node.workspace", errors);
  const port = optionalInteger(node.port, "node.port", errors, 1, 65535);
  const maxConcurrentAutomations = optionalInteger(node.maxConcurrentAutomations, "node.maxConcurrentAutomations", errors, 0, 100);
  const agent = optionalString(defaults.agent, "defaults.agent", errors, 120)?.toLowerCase();
  const sandbox = defaults.sandbox as ConfigSandbox | undefined;
  const approval = defaults.approval as ConfigApproval | undefined;
  if (sandbox !== undefined && !SANDBOXES.has(sandbox)) errors.push("defaults.sandbox must be read-only, workspace-write, or danger-full-access");
  if (approval !== undefined && !APPROVALS.has(approval)) errors.push("defaults.approval must be never, risky, always, or autonomous");
  const maxSandbox = safety.maxSandbox as ConfigSandbox | undefined;
  const approvalFloor = safety.approvalFloor as "risky" | "always" | undefined;
  if (maxSandbox !== undefined && !SANDBOXES.has(maxSandbox)) errors.push("safety.maxSandbox must be read-only, workspace-write, or danger-full-access");
  if (approvalFloor !== undefined && approvalFloor !== "risky" && approvalFloor !== "always") errors.push("safety.approvalFloor must be risky or always");
  let model: NodeConfig["defaults"] extends infer _ ? { provider: string; id: string } | null | undefined : never;
  if (defaults.model === null) model = null;
  else if (defaults.model !== undefined) {
    const m = record(defaults.model);
    const provider = optionalString(m?.provider, "defaults.model.provider", errors, 120);
    const id = optionalString(m?.id, "defaults.model.id", errors, 300);
    if (m) unknownKeys(m, ["provider", "id"], "defaults.model", errors);
    else errors.push("defaults.model must be null or an object");
    if (provider && id) model = { provider, id };
  }
  const sync = optionalBoolean(sessions.sync, "sessions.sync", errors);
  const worktreeSync = optionalBoolean(sessions.worktreeSync, "sessions.worktreeSync", errors);
  const standbyNodeId = optionalString(sessions.standbyNodeId, "sessions.standbyNodeId", errors, 200);
  const resume = sessions.resume as "auto" | "manual" | undefined;
  if (resume !== undefined && resume !== "auto" && resume !== "manual") errors.push("sessions.resume must be auto or manual");
  const autoAttachToolImages = optionalBoolean(sessions.autoAttachToolImages, "sessions.autoAttachToolImages", errors);
  // Upper bound is the wall-clock turn cap (60 min): a wedged window at/above it
  // would never fire before the cap. 0 disables the band.
  const wedgedTurnMinutes = optionalInteger(sessions.wedgedTurnMinutes, "sessions.wedgedTurnMinutes", errors, 0, 60);
  const issuePrompt = optionalString(github.issuePrompt, "github.issuePrompt", errors, 16_000);
  let checks: string[] | undefined;
  if (automation.checks !== undefined) {
    if (!Array.isArray(automation.checks)) errors.push("automation.checks must be a list of package-script names");
    else {
      checks = [];
      for (const raw of automation.checks) {
        if (typeof raw !== "string" || !SCRIPT_RE.test(raw)) errors.push("automation.checks entries may contain only letters, numbers, _, :, ., and -");
        else if (!checks.includes(raw)) checks.push(raw);
      }
      if (checks.length > 10) errors.push("automation.checks may contain at most 10 entries");
    }
  }
  const checkTimeoutMinutes = optionalInteger(automation.checkTimeoutMinutes, "automation.checkTimeoutMinutes", errors, 1, 30);
  const agents: NonNullable<NodeConfig["agents"]> = {};
  for (const [id, raw] of Object.entries(agentsRaw)) {
    const at = `agents.${id}`;
    const spec = record(raw);
    if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) { errors.push(`${at} must use a lowercase slug`); continue; }
    if (!spec) { errors.push(`${at} must be an object`); continue; }
    unknownKeys(spec, ["extends", "label", "command", "args", "jsonArgs", "parserId", "promptMode", "hidden"], at, errors);
    const extend = optionalString(spec.extends, `${at}.extends`, errors, 80);
    const list = (value: unknown, key: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === "string" && item.length <= 4096)) {
        errors.push(`${at}.${key} must be a string list of at most 100 entries (4096 characters each)`);
        return undefined;
      }
      return value as string[];
    };
    const promptMode = spec.promptMode as "stdin" | "argv" | undefined;
    if (promptMode !== undefined && promptMode !== "stdin" && promptMode !== "argv") errors.push(`${at}.promptMode must be stdin or argv`);
    const hidden = optionalBoolean(spec.hidden, `${at}.hidden`, errors);
    if (extend) agents[id] = {
      extends: extend,
      label: optionalString(spec.label, `${at}.label`, errors, 120),
      command: optionalString(spec.command, `${at}.command`, errors, 500),
      args: list(spec.args, "args"),
      jsonArgs: list(spec.jsonArgs, "jsonArgs"),
      parserId: optionalString(spec.parserId, `${at}.parserId`, errors, 80),
      promptMode,
      hidden,
    };
  }
  const envOut: Record<string, string> = {};
  for (const [key, raw] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(key)) errors.push(`environment.${key} must be an uppercase environment-variable name`);
    else if (typeof raw !== "string") errors.push(`environment.${key} must be a string`);
    else if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key) && raw && !/^(?:secret|env|op):\/\//.test(raw)) {
      errors.push(`environment.${key} looks sensitive; store it with 'bivy secrets' and use a secret://, env://, or op:// reference`);
    } else envOut[key] = raw;
  }
  if (worktreeSync && sync === false) errors.push("sessions.worktreeSync requires sessions.sync");
  if (environment.BIVY_APPROVAL_MODE !== undefined || environment.BIVY_SANDBOX !== undefined || environment.BIVY_RUNTIME !== undefined) {
    warnings.push("Prefer typed defaults.* fields over environment overrides for agent, sandbox, and approval mode");
  }

  const config: NodeConfig = {
    version: 1,
    ...(Object.keys(node).length ? { node: { workspace, port, maxConcurrentAutomations } } : {}),
    ...(Object.keys(defaults).length ? { defaults: { agent, model, sandbox, approval } } : {}),
    ...(Object.keys(safety).length ? { safety: { maxSandbox, approvalFloor } } : {}),
    ...(Object.keys(sessions).length ? { sessions: { sync, worktreeSync, standbyNodeId, resume, autoAttachToolImages, wedgedTurnMinutes } } : {}),
    ...(Object.keys(github).length ? { github: { issuePrompt } } : {}),
    ...(Object.keys(automation).length ? { automation: { checks, checkTimeoutMinutes } } : {}),
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(Object.keys(envOut).length ? { environment: envOut } : {}),
  };
  // Canonical form omits undefined/empty projection artifacts so a write/read
  // round-trip is stable and `in` checks distinguish omitted from explicit null.
  const clean = JSON.parse(JSON.stringify(config)) as NodeConfig;
  return { ok: errors.length === 0, config: errors.length ? undefined : clean, errors, warnings };
}

export function parseNodeConfig(text: string): NodeConfigResult {
  try { return validateNodeConfig(parseYaml(text, { uniqueKeys: true })); }
  catch (error) { return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`], warnings: [] }; }
}

export function nodeConfigPath(dataDir: string): string { return path.join(dataDir, NODE_CONFIG_FILE); }

export function readNodeConfig(dataDir: string): NodeConfig | undefined {
  const file = nodeConfigPath(dataDir);
  if (!fs.existsSync(file)) return undefined;
  const result = parseNodeConfig(fs.readFileSync(file, "utf8"));
  if (!result.ok || !result.config) throw new Error(`Invalid ${file}: ${result.errors.join("; ")}`);
  return result.config;
}

export function writeNodeConfig(dataDir: string, config: NodeConfig): void {
  const result = validateNodeConfig(config);
  if (!result.ok || !result.config) throw new Error(`Invalid node configuration: ${result.errors.join("; ")}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = nodeConfigPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, stringifyYaml(result.config, { lineWidth: 100 }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function configToLegacySettings(config: NodeConfig): Record<string, unknown> {
  return {
    ...(config.defaults?.agent ? { defaultAgent: config.defaults.agent } : {}),
    ...(config.defaults && "model" in config.defaults ? { defaultModel: config.defaults.model ?? null } : {}),
    ...(config.defaults?.sandbox ? { defaultSandbox: config.defaults.sandbox } : {}),
    ...(config.defaults?.approval ? { approvalMode: config.defaults.approval } : {}),
    ...(config.node?.maxConcurrentAutomations !== undefined ? { githubMaxConcurrent: config.node.maxConcurrentAutomations } : {}),
    ...(config.github?.issuePrompt ? { githubIssuePrompt: config.github.issuePrompt } : {}),
    ...(config.sessions?.sync !== undefined ? { sessionSync: config.sessions.sync } : {}),
    ...(config.sessions?.worktreeSync !== undefined ? { worktreeSync: config.sessions.worktreeSync } : {}),
    ...(config.sessions?.standbyNodeId ? { syncStandbyNodeId: config.sessions.standbyNodeId } : {}),
    ...(config.sessions?.resume ? { sessionResumeMode: config.sessions.resume } : {}),
    ...(config.sessions?.autoAttachToolImages !== undefined ? { autoAttachToolImages: config.sessions.autoAttachToolImages } : {}),
  };
}

export function mergeLegacyIntoNodeConfig(cli: Record<string, unknown>, settings: Record<string, unknown>): NodeConfig {
  const env = record(cli.env) ?? {};
  const envStrings = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const defaultModelRaw = record(settings.defaultModel);
  const model = defaultModelRaw && typeof defaultModelRaw.provider === "string" && typeof defaultModelRaw.id === "string"
    ? { provider: defaultModelRaw.provider, id: defaultModelRaw.id } : null;
  const known = new Set(["BIVY_RUNTIME", "BIVY_SANDBOX", "BIVY_APPROVAL_MODE", "BIVY_AUTOMATION_CHECKS", "BIVY_AUTOMATION_CHECK_TIMEOUT_MS", "BIVY_CUSTOM_AGENTS"]);
  const advanced = Object.fromEntries(Object.entries(envStrings).filter(([key, value]) => {
    if (known.has(key)) return false;
    // Preserve legacy plaintext credentials only in cli.json until their
    // existing migration/vault flow consumes them; never copy them into the new
    // user-authored YAML.
    return !/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key)
      || !value
      || /^(?:secret|env|op):\/\//.test(value);
  }));
  let agents: NodeConfig["agents"];
  if (envStrings.BIVY_CUSTOM_AGENTS) {
    try {
      const parsed = JSON.parse(envStrings.BIVY_CUSTOM_AGENTS);
      if (Array.isArray(parsed)) agents = Object.fromEntries(parsed.filter((item) => item && typeof item.id === "string").map(({ id, ...spec }) => [id, spec]));
    } catch { /* malformed legacy value stays out of canonical config */ }
  }
  let checks: string[] | undefined;
  const rawChecks = envStrings.BIVY_AUTOMATION_CHECKS;
  if (rawChecks) {
    try { const parsed = JSON.parse(rawChecks); if (Array.isArray(parsed)) checks = parsed.filter((item): item is string => typeof item === "string" && SCRIPT_RE.test(item)).slice(0, 10); }
    catch { checks = rawChecks.split(",").map((s) => s.trim()).filter((item) => SCRIPT_RE.test(item)).slice(0, 10); }
  }
  const sandboxCandidate = typeof settings.defaultSandbox === "string" ? settings.defaultSandbox : envStrings.BIVY_SANDBOX;
  const approvalCandidate = typeof settings.approvalMode === "string" ? settings.approvalMode : envStrings.BIVY_APPROVAL_MODE;
  const timeoutMs = Number(envStrings.BIVY_AUTOMATION_CHECK_TIMEOUT_MS);
  const migrated: NodeConfig = {
    version: 1,
    node: {
      workspace: typeof cli.workspace === "string" ? cli.workspace : undefined,
      port: Number.isInteger(cli.port) ? Number(cli.port) : undefined,
      maxConcurrentAutomations: Number.isInteger(settings.githubMaxConcurrent) ? Number(settings.githubMaxConcurrent) : undefined,
    },
    defaults: {
      agent: typeof settings.defaultAgent === "string" ? settings.defaultAgent : envStrings.BIVY_RUNTIME,
      model,
      sandbox: SANDBOXES.has(sandboxCandidate ?? "") ? sandboxCandidate as ConfigSandbox : undefined,
      approval: APPROVALS.has(approvalCandidate ?? "") ? approvalCandidate as ConfigApproval : undefined,
    },
    sessions: {
      sync: settings.sessionSync === true,
      worktreeSync: settings.worktreeSync === true,
      standbyNodeId: typeof settings.syncStandbyNodeId === "string" ? settings.syncStandbyNodeId : undefined,
      resume: settings.sessionResumeMode === "manual" ? "manual" : "auto",
      autoAttachToolImages: settings.autoAttachToolImages === true,
    },
    github: { issuePrompt: typeof settings.githubIssuePrompt === "string" ? settings.githubIssuePrompt : undefined },
    automation: {
      checks,
      checkTimeoutMinutes: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.min(30, Math.ceil(timeoutMs / 60_000))) : undefined,
    },
    ...(agents && Object.keys(agents).length ? { agents } : {}),
    ...(Object.keys(advanced).length ? { environment: advanced } : {}),
  };
  let result = validateNodeConfig(migrated);
  if (!result.ok && migrated.agents) {
    // Legacy custom-agent JSON was historically best-effort. Do not let one
    // malformed old extension prevent the node from migrating and starting.
    delete migrated.agents;
    result = validateNodeConfig(migrated);
  }
  if (!result.ok || !result.config) throw new Error(`Legacy configuration could not be migrated: ${result.errors.join("; ")}`);
  return result.config;
}

export function setConfigValue(config: NodeConfig, dotted: string, value: unknown): NodeConfig {
  const allowed = new Set([
    "node.workspace", "node.port", "node.maxConcurrentAutomations",
    "defaults.agent", "defaults.model", "defaults.sandbox", "defaults.approval",
    "safety.maxSandbox", "safety.approvalFloor",
    "sessions.sync", "sessions.worktreeSync", "sessions.standbyNodeId", "sessions.resume", "sessions.autoAttachToolImages", "sessions.wedgedTurnMinutes",
    "github.issuePrompt", "automation.checks", "automation.checkTimeoutMinutes",
  ]);
  if (!allowed.has(dotted) && !/^agents\.[a-z][a-z0-9-]{1,47}$/.test(dotted) && !/^environment\.[A-Z][A-Z0-9_]+$/.test(dotted)) throw new Error(`Unknown configuration key: ${dotted}`);
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  const parts = dotted.split(".");
  let cursor = copy;
  for (const part of parts.slice(0, -1)) {
    const next = record(cursor[part]) ?? {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[parts.at(-1)!] = value;
  const result = validateNodeConfig(copy);
  if (!result.ok || !result.config) throw new Error(result.errors.join("; "));
  return result.config;
}

export function getConfigValue(config: NodeConfig, dotted: string): unknown {
  let value: unknown = config;
  for (const part of dotted.split(".")) value = record(value)?.[part];
  return value;
}
