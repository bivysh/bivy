#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  configToLegacySettings,
  getConfigValue,
  mergeLegacyIntoNodeConfig,
  nodeConfigPath,
  parseNodeConfig,
  readNodeConfig,
  setConfigValue,
  validateNodeConfig,
  writeNodeConfig,
  type NodeConfig,
} from "./node-config.js";
import { PROJECT_POLICY_PATH, STARTER_PROJECT_POLICY, findProjectPolicy, loadProjectPolicy, parseProjectPolicy, resolveProjectSafety } from "./project-policy.js";
import { PROJECT_ENVIRONMENT_PATH, STARTER_PROJECT_ENVIRONMENT, parseProjectEnvironment } from "./project-environment.js";

const dataDir = path.resolve(process.env.BIVY_DATA_DIR || path.join(process.env.HOME || "", ".bivy"));
const file = nodeConfigPath(dataDir);

function readJson(name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function writeJson(name: string, value: Record<string, unknown>) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Keep old readers working during the migration. These JSON files become
 * generated compatibility projections, not user-authored configuration. */
function projectLegacy(config: NodeConfig) {
  const cli = readJson("cli.json");
  const oldEnv = cli.env && typeof cli.env === "object" ? cli.env as Record<string, unknown> : {};
  const known = new Set(["BIVY_RUNTIME", "BIVY_SANDBOX", "BIVY_APPROVAL_MODE", "BIVY_AUTOMATION_CHECKS", "BIVY_AUTOMATION_CHECK_TIMEOUT_MS", "BIVY_CUSTOM_AGENTS"]);
  const env = Object.fromEntries(Object.entries(oldEnv).filter(([key]) => !known.has(key)));
  Object.assign(env, config.environment ?? {});
  if (config.agents) env.BIVY_CUSTOM_AGENTS = JSON.stringify(Object.entries(config.agents).map(([id, spec]) => ({ id, ...spec })));
  writeJson("cli.json", {
    ...cli,
    ...(config.node?.workspace ? { workspace: config.node.workspace } : {}),
    ...(config.node?.port ? { port: config.node.port } : {}),
    env,
  });
  writeJson("settings.json", { ...readJson("settings.json"), ...configToLegacySettings(config) });
}

function migrate(fromLegacy = false): { config: NodeConfig; created: boolean } {
  const existing = readNodeConfig(dataDir);
  if (existing && !fromLegacy) { projectLegacy(existing); return { config: existing, created: false }; }
  const config = mergeLegacyIntoNodeConfig(readJson("cli.json"), readJson("settings.json"));
  if (existing && fromLegacy) {
    // Setup still owns workspace/port/initial-agent selection. Fold only those
    // fields back into the canonical file; preserve every advanced user edit.
    config.node = { ...existing.node, workspace: config.node?.workspace, port: config.node?.port };
    config.defaults = { ...existing.defaults, agent: config.defaults?.agent };
    Object.assign(config, {
      safety: existing.safety,
      sessions: existing.sessions,
      github: existing.github,
      automation: existing.automation,
      agents: existing.agents,
      environment: existing.environment,
    });
  }
  const result = validateNodeConfig(config);
  if (!result.ok || !result.config) throw new Error(`Legacy settings could not be migrated: ${result.errors.join("; ")}`);
  writeNodeConfig(dataDir, result.config);
  projectLegacy(result.config);
  return { config: result.config, created: true };
}

function usage(): never {
  console.log(`Usage: bivy config <command> [arguments]

Typed node configuration in ${file}

Commands:
  init [--project|--environment]      Create node config, .bivy/policy.yaml, or .bivy/environment.yaml
  validate [--project|--environment]  Validate node, repository policy, or environment config
  show [--json]           Print the canonical configuration
  get <key>               Read a dotted key
  set <key> <yaml-value>  Set and validate a dotted key
  unset <key>             Remove a dotted key
  explain <key>           Show the effective value and where it came from
  path [--project|--environment]      Print the configuration path

Examples:
  bivy config set defaults.agent codex
  bivy config set defaults.sandbox read-only
  bivy config set node.maxConcurrentAutomations 2
  bivy config set automation.checks '[test, lint, typecheck]'
  bivy config set node.capabilities '[gpu, docker]'
  bivy config explain defaults.sandbox
  bivy config init --environment
  bivy config validate --environment

Secrets belong in the vault; use secret://, env://, or op:// references in
advanced environment entries. Restart the node after changing boot settings.`);
  process.exit(0);
}

const ENV_FOR_KEY: Record<string, string> = {
  "node.workspace": "BIVY_WORKSPACE",
  "node.port": "PORT",
  "defaults.agent": "BIVY_RUNTIME",
  "defaults.sandbox": "BIVY_SANDBOX",
  "defaults.approval": "BIVY_APPROVAL_MODE",
  "sessions.autoAttachToolImages": "BIVY_AUTO_ATTACH_TOOL_IMAGES",
  "automation.checks": "BIVY_AUTOMATION_CHECKS",
  "automation.checkTimeoutMinutes": "BIVY_AUTOMATION_CHECK_TIMEOUT_MS",
};

const BUILTIN_VALUES: Record<string, unknown> = {
  "node.port": 4317,
  "node.maxConcurrentAutomations": 0,
  "defaults.agent": "pi",
  "defaults.model": null,
  "defaults.sandbox": "workspace-write",
  "defaults.approval": "autonomous",
  "sessions.sync": false,
  "sessions.worktreeSync": false,
  "sessions.resume": "auto",
  "sessions.autoAttachToolImages": false,
  "automation.checks": ["test", "lint", "typecheck"],
  "automation.checkTimeoutMinutes": 10,
};

type EffectiveValue = { value: unknown; source: string; configured: unknown; env?: string; detail?: string };
function baseEffectiveValue(config: NodeConfig, key: string): EffectiveValue {
  const configured = getConfigValue(config, key);
  const envName = key.startsWith("environment.") ? key.slice("environment.".length) : ENV_FOR_KEY[key];
  const raw = envName ? process.env[envName] : undefined;
  let value: unknown = configured === undefined ? BUILTIN_VALUES[key] : configured;
  let source = configured === undefined ? "built-in default" : file;
  if (raw !== undefined) {
    value = raw;
    if (key === "node.port") value = Number(raw);
    if (key === "automation.checkTimeoutMinutes") value = Number(raw) / 60_000;
    if (key === "automation.checks") {
      try { value = JSON.parse(raw); } catch { value = raw.split(",").map((v) => v.trim()).filter(Boolean); }
    }
    source = `environment ${envName}`;
  }
  return { value, source, configured, env: envName };
}
function effectiveValue(config: NodeConfig, key: string): EffectiveValue {
  const base = baseEffectiveValue(config, key);
  if (key !== "defaults.sandbox" && key !== "defaults.approval") return base;
  const requestedSandbox = baseEffectiveValue(config, "defaults.sandbox").value;
  const requestedApproval = baseEffectiveValue(config, "defaults.approval").value;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(String(requestedSandbox))
    || !["never", "risky", "always", "autonomous"].includes(String(requestedApproval))) return base;
  const nodeBounded = resolveProjectSafety(
    config.safety,
    requestedSandbox as "read-only" | "workspace-write" | "danger-full-access",
    requestedApproval as "never" | "risky" | "always" | "autonomous",
  );
  let resolved = key === "defaults.sandbox" ? nodeBounded.sandbox : nodeBounded.approval;
  let source = base.source;
  const restrictions: string[] = [];
  if (resolved !== base.value) {
    source = file;
    restrictions.push(`requested value ${JSON.stringify(base.value)} from ${base.source} was restricted by the node safety floor`);
  }
  const policyPath = findProjectPolicy(process.cwd());
  const projectBounded = resolveProjectSafety(loadProjectPolicy(process.cwd())?.safety, nodeBounded.sandbox, nodeBounded.approval);
  const projectResolved = key === "defaults.sandbox" ? projectBounded.sandbox : projectBounded.approval;
  if (projectResolved !== resolved && policyPath) {
    resolved = projectResolved;
    source = policyPath;
    restrictions.push("the effective node request was further restricted by repository policy");
  }
  return restrictions.length ? { ...base, value: resolved, source, detail: restrictions.join("; ") } : base;
}

function redact(config: NodeConfig): NodeConfig {
  const copy = structuredClone(config);
  if (copy.environment) {
    for (const key of Object.keys(copy.environment)) {
      if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key) && !/^(?:secret|env|op):\/\//.test(copy.environment[key]!)) copy.environment[key] = "[redacted]";
    }
  }
  return copy;
}

function unsetValue(config: NodeConfig, dotted: string): NodeConfig {
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  const parts = dotted.split(".");
  let cursor: Record<string, unknown> | undefined = copy;
  for (const part of parts.slice(0, -1)) {
    const child: unknown = cursor?.[part];
    cursor = child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
  }
  if (!cursor || !Object.prototype.hasOwnProperty.call(cursor, parts.at(-1)!)) throw new Error(`Configuration key is not set: ${dotted}`);
  delete cursor[parts.at(-1)!];
  const result = validateNodeConfig(copy);
  if (!result.ok || !result.config) throw new Error(result.errors.join("; "));
  return result.config;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "-h", "--help"].includes(command)) usage();
  if (command === "path") {
    console.log(args.includes("--environment") ? path.resolve(PROJECT_ENVIRONMENT_PATH) : args.includes("--project") ? path.resolve(PROJECT_POLICY_PATH) : file);
    return;
  }
  if (command === "edit") {
    const target = args.includes("--environment") ? path.resolve(PROJECT_ENVIRONMENT_PATH) : args.includes("--project") ? path.resolve(PROJECT_POLICY_PATH) : file;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, "");
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(editor, [target], { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`${editor} exited with ${res.status ?? res.error?.message ?? "error"}`);
    return;
  }
  if (command === "init" && args.includes("--project")) {
    const target = path.resolve(PROJECT_POLICY_PATH);
    if (fs.existsSync(target)) throw new Error(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, STARTER_PROJECT_POLICY, { mode: 0o644 });
    console.log(`Created ${target}`);
    return;
  }
  if (command === "init" && args.includes("--environment")) {
    const target = path.resolve(PROJECT_ENVIRONMENT_PATH);
    if (fs.existsSync(target)) throw new Error(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, STARTER_PROJECT_ENVIRONMENT, { mode: 0o644 });
    console.log(`Created ${target}`);
    return;
  }
  if (command === "init" || command === "migrate") {
    const result = migrate(args.includes("--from-legacy"));
    if (!args.includes("--quiet")) console.log(`${result.created ? "Created" : "Synchronized"} ${file}`);
    return;
  }
  if (command === "validate" && args.includes("--project")) {
    const target = path.resolve(PROJECT_POLICY_PATH);
    const result = parseProjectPolicy(fs.readFileSync(target, "utf8"));
    if (!result.ok) { for (const error of result.errors) console.error(`error: ${error}`); process.exit(1); }
    console.log(`Valid: ${target}`);
    return;
  }
  if (command === "validate" && args.includes("--environment")) {
    const target = path.resolve(PROJECT_ENVIRONMENT_PATH);
    const result = parseProjectEnvironment(fs.readFileSync(target, "utf8"));
    if (!result.ok) { for (const error of result.errors) console.error(`error: ${error}`); process.exit(1); }
    console.log(`Valid: ${target}`);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`No ${file}. Run 'bivy config init'.`);
  if (command === "validate") {
    const result = parseNodeConfig(fs.readFileSync(file, "utf8"));
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    if (!result.ok) { for (const error of result.errors) console.error(`error: ${error}`); process.exit(1); }
    console.log(`Valid: ${file}`);
    return;
  }
  let config = readNodeConfig(dataDir)!;
  if (command === "show") {
    const safe = redact(config);
    console.log(args.includes("--json") ? JSON.stringify(safe, null, 2) : stringifyYaml(safe, { lineWidth: 100 }).trimEnd());
    return;
  }
  const key = args[0];
  if (!key) throw new Error(`${command} requires a dotted configuration key`);
  if (command === "get") {
    const value = getConfigValue(config, key);
    if (value === undefined) process.exitCode = 1;
    else console.log(typeof value === "object" ? stringifyYaml(value).trimEnd() : String(value));
    return;
  }
  if (command === "explain") {
    const info = effectiveValue(config, key);
    console.log(`${key} = ${typeof info.value === "object" ? JSON.stringify(info.value) : String(info.value)}`);
    console.log(`source: ${info.source}`);
    if (info.detail) console.log(`composition: ${info.detail}`);
    if (info.source.startsWith("environment") && info.configured !== undefined) console.log(`config file: ${JSON.stringify(info.configured)} (overridden)`);
    if (info.env && !info.source.startsWith("environment")) {
      const envValue = process.env[info.env];
      console.log(`environment override: ${info.env} (${envValue === undefined ? "unset" : `${JSON.stringify(envValue)}; restricted`})`);
    }
    return;
  }
  if (command === "set") {
    if (args.length < 2) throw new Error("set requires <key> <yaml-value>");
    const raw = args.slice(1).join(" ");
    let value: unknown;
    try { value = parseYaml(raw); } catch (error) { throw new Error(`Invalid YAML value: ${error instanceof Error ? error.message : String(error)}`); }
    config = setConfigValue(config, key, value);
    writeNodeConfig(dataDir, config);
    projectLegacy(config);
    console.log(`${key} = ${JSON.stringify(getConfigValue(config, key))}`);
    return;
  }
  if (command === "unset") {
    config = unsetValue(config, key);
    writeNodeConfig(dataDir, config);
    projectLegacy(config);
    console.log(`Unset ${key}`);
    return;
  }
  throw new Error(`Unknown config command: ${command}`);
}

main().catch((error) => {
  console.error(`Config error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
