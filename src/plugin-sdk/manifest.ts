// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Versioned, declarative Bivy plugin manifest.
 *
 * v1alpha1 intentionally supports only agent contributions. A manifest never
 * executes code inside the daemon: process agents are ordinary child processes;
 * ACP agents are launched through Bivy's existing out-of-process ACP bridge.
 */
import { parse as parseSemver, satisfies, valid, validRange } from "semver";
import { parse as parseYaml } from "yaml";

export const PLUGIN_API_VERSION = "bivy.sh/v1alpha1" as const;
export const PLUGIN_KIND = "Plugin" as const;
export const DEFAULT_PLUGIN_MANIFEST_NAMES = ["bivy.plugin.yaml", "bivy.plugin.yml", "bivy.plugin.json", "manifest.yaml", "manifest.json"] as const;

export type PluginAuthOwner = "agent" | "bivy" | "mixed";

export interface PluginModelChoice {
  id: string;
  name?: string;
  provider?: string;
}

export interface ProcessAgentAdapter {
  kind: "process";
  command: string;
  args?: string[];
  promptMode?: "argv" | "stdin";
  structured?: {
    args: string[];
    parser: string;
  };
  resume?: {
    args: string[];
  };
  model?: {
    flag: string;
    insertAt?: number;
    choices: PluginModelChoice[];
  };
}

export interface AcpAgentAdapter {
  kind: "acp";
  command: string;
  args?: string[];
}

export interface PluginAgentContribution {
  id: string;
  name: string;
  description?: string;
  hidden?: boolean;
  authOwner?: PluginAuthOwner;
  adapter: ProcessAgentAdapter | AcpAgentAdapter;
}

export interface PluginManifest {
  apiVersion: typeof PLUGIN_API_VERSION;
  kind: typeof PLUGIN_KIND;
  metadata: {
    id: string;
    name: string;
    version: string;
    description?: string;
    homepage?: string;
  };
  requires?: {
    bivy: string;
  };
  contributes: {
    agents: PluginAgentContribution[];
  };
}

export interface PluginManifestResult {
  ok: boolean;
  manifest?: PluginManifest;
  errors: string[];
}

export interface PluginCompatibilityResult {
  compatible: boolean;
  currentVersion: string;
  requiredRange?: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PARSER_IDS = new Set([
  "bivy-protocol",
  "claude-stream-json",
  "codex-json",
  "goose-stream-json",
  "gemini-json",
  "generic-stream-json",
  "generic-json",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) errors.push(`${at}.${key} is not supported`);
}

function requiredString(value: unknown, at: string, errors: string[], max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${at} is required`);
    return undefined;
  }
  const out = value.trim();
  if (out.length > max) {
    errors.push(`${at} must be at most ${max} characters`);
    return undefined;
  }
  return out;
}

function optionalString(value: unknown, at: string, errors: string[], max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, at, errors, max);
}

function stringList(value: unknown, at: string, errors: string[], opts: { maxItems?: number; maxLength?: number } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  const maxItems = opts.maxItems ?? 100;
  const maxLength = opts.maxLength ?? 4096;
  if (!Array.isArray(value)) {
    errors.push(`${at} must be a list of strings`);
    return undefined;
  }
  if (value.length > maxItems) errors.push(`${at} may contain at most ${maxItems} entries`);
  const out: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string" || item.length > maxLength || item.includes("\0")) {
      errors.push(`${at} entries must be strings of at most ${maxLength} characters without NUL bytes`);
    } else {
      out.push(item);
    }
  }
  return out;
}

function parseModels(value: unknown, at: string, errors: string[]): PluginModelChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    errors.push(`${at} must be a non-empty list of at most 100 models`);
    return undefined;
  }
  const out: PluginModelChoice[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const itemAt = `${at}[${i}]`;
    const raw = object(value[i]);
    if (!raw) {
      errors.push(`${itemAt} must be an object`);
      continue;
    }
    rejectUnknown(raw, ["id", "name", "provider"], itemAt, errors);
    const id = requiredString(raw.id, `${itemAt}.id`, errors, 300);
    const name = optionalString(raw.name, `${itemAt}.name`, errors, 120);
    const provider = optionalString(raw.provider, `${itemAt}.provider`, errors, 120);
    if (!id) continue;
    if (ids.has(id)) errors.push(`${at} contains duplicate model id ${id}`);
    ids.add(id);
    out.push({ id, ...(name ? { name } : {}), ...(provider ? { provider } : {}) });
  }
  return out;
}

function parseProcessAdapter(raw: Record<string, unknown>, at: string, errors: string[]): ProcessAgentAdapter | undefined {
  rejectUnknown(raw, ["kind", "command", "args", "promptMode", "structured", "resume", "model"], at, errors);
  const command = requiredString(raw.command, `${at}.command`, errors, 500);
  if (command?.includes("\0")) errors.push(`${at}.command must not contain NUL bytes`);
  const args = stringList(raw.args, `${at}.args`, errors);
  const promptMode = raw.promptMode as ProcessAgentAdapter["promptMode"] | undefined;
  if (promptMode !== undefined && promptMode !== "argv" && promptMode !== "stdin") {
    errors.push(`${at}.promptMode must be argv or stdin`);
  }

  let structured: ProcessAgentAdapter["structured"];
  if (raw.structured !== undefined) {
    const value = object(raw.structured);
    if (!value) errors.push(`${at}.structured must be an object`);
    else {
      rejectUnknown(value, ["args", "parser"], `${at}.structured`, errors);
      const structuredArgs = stringList(value.args, `${at}.structured.args`, errors) ?? [];
      const parser = requiredString(value.parser, `${at}.structured.parser`, errors, 80);
      if (parser && !PARSER_IDS.has(parser)) {
        errors.push(`${at}.structured.parser must be one of ${[...PARSER_IDS].join(", ")}`);
      }
      if (parser) structured = { args: structuredArgs, parser };
    }
  }

  let resume: ProcessAgentAdapter["resume"];
  if (raw.resume !== undefined) {
    const value = object(raw.resume);
    if (!value) errors.push(`${at}.resume must be an object`);
    else {
      rejectUnknown(value, ["args"], `${at}.resume`, errors);
      const resumeArgs = stringList(value.args, `${at}.resume.args`, errors) ?? [];
      if (!resumeArgs.some((arg) => arg.includes("{id}"))) errors.push(`${at}.resume.args must contain an {id} placeholder`);
      resume = { args: resumeArgs };
    }
  }

  let model: ProcessAgentAdapter["model"];
  if (raw.model !== undefined) {
    const value = object(raw.model);
    if (!value) errors.push(`${at}.model must be an object`);
    else {
      rejectUnknown(value, ["flag", "insertAt", "choices"], `${at}.model`, errors);
      const flag = requiredString(value.flag, `${at}.model.flag`, errors, 120);
      const insertAt = value.insertAt === undefined ? undefined : Number(value.insertAt);
      if (insertAt !== undefined && (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > 20)) {
        errors.push(`${at}.model.insertAt must be an integer from 0 to 20`);
      }
      const choices = parseModels(value.choices, `${at}.model.choices`, errors);
      if (flag && choices?.length) model = { flag, ...(insertAt !== undefined ? { insertAt } : {}), choices };
    }
  }

  if (!command) return undefined;
  return {
    kind: "process",
    command,
    ...(args ? { args } : {}),
    ...(promptMode ? { promptMode } : {}),
    ...(structured ? { structured } : {}),
    ...(resume ? { resume } : {}),
    ...(model ? { model } : {}),
  };
}

function parseAcpAdapter(raw: Record<string, unknown>, at: string, errors: string[]): AcpAgentAdapter | undefined {
  rejectUnknown(raw, ["kind", "command", "args"], at, errors);
  const command = requiredString(raw.command, `${at}.command`, errors, 500);
  if (command?.includes("\0")) errors.push(`${at}.command must not contain NUL bytes`);
  const args = stringList(raw.args, `${at}.args`, errors);
  return command ? { kind: "acp", command, ...(args ? { args } : {}) } : undefined;
}

function parseAgent(value: unknown, index: number, errors: string[]): PluginAgentContribution | undefined {
  const at = `contributes.agents[${index}]`;
  const raw = object(value);
  if (!raw) {
    errors.push(`${at} must be an object`);
    return undefined;
  }
  rejectUnknown(raw, ["id", "name", "description", "hidden", "authOwner", "adapter"], at, errors);
  const id = requiredString(raw.id, `${at}.id`, errors, 48)?.toLowerCase();
  if (id && !ID_RE.test(id)) errors.push(`${at}.id must be a lowercase slug (2-48 characters)`);
  const name = requiredString(raw.name, `${at}.name`, errors, 120);
  const description = optionalString(raw.description, `${at}.description`, errors, 500);
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") errors.push(`${at}.hidden must be true or false`);
  const authOwner = raw.authOwner as PluginAuthOwner | undefined;
  if (authOwner !== undefined && authOwner !== "agent" && authOwner !== "bivy" && authOwner !== "mixed") {
    errors.push(`${at}.authOwner must be agent, bivy, or mixed`);
  }
  const adapterRaw = object(raw.adapter);
  let adapter: ProcessAgentAdapter | AcpAgentAdapter | undefined;
  if (!adapterRaw) errors.push(`${at}.adapter must be an object`);
  else if (adapterRaw.kind === "process") adapter = parseProcessAdapter(adapterRaw, `${at}.adapter`, errors);
  else if (adapterRaw.kind === "acp") adapter = parseAcpAdapter(adapterRaw, `${at}.adapter`, errors);
  else errors.push(`${at}.adapter.kind must be process or acp`);
  if (!id || !name || !adapter) return undefined;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(authOwner ? { authOwner } : {}),
    adapter,
  };
}

export function validatePluginManifest(value: unknown): PluginManifestResult {
  const errors: string[] = [];
  const root = object(value);
  if (!root) return { ok: false, errors: ["manifest must be an object"] };
  rejectUnknown(root, ["apiVersion", "kind", "metadata", "requires", "contributes"], "manifest", errors);
  if (root.apiVersion !== PLUGIN_API_VERSION) errors.push(`apiVersion must be ${PLUGIN_API_VERSION}`);
  if (root.kind !== PLUGIN_KIND) errors.push(`kind must be ${PLUGIN_KIND}`);

  const metadataRaw = object(root.metadata);
  let metadata: PluginManifest["metadata"] | undefined;
  if (!metadataRaw) errors.push("metadata must be an object");
  else {
    rejectUnknown(metadataRaw, ["id", "name", "version", "description", "homepage"], "metadata", errors);
    const id = requiredString(metadataRaw.id, "metadata.id", errors, 48)?.toLowerCase();
    if (id && !ID_RE.test(id)) errors.push("metadata.id must be a lowercase slug (2-48 characters)");
    const name = requiredString(metadataRaw.name, "metadata.name", errors, 120);
    const version = requiredString(metadataRaw.version, "metadata.version", errors, 64);
    if (version && !VERSION_RE.test(version)) errors.push("metadata.version must be a semantic version such as 1.2.3 or 1.2.3-beta.1");
    const description = optionalString(metadataRaw.description, "metadata.description", errors, 500);
    const homepage = optionalString(metadataRaw.homepage, "metadata.homepage", errors, 1000);
    if (homepage) {
      try {
        const url = new URL(homepage);
        if (url.protocol !== "https:" && url.protocol !== "http:") errors.push("metadata.homepage must be an http(s) URL");
      } catch { errors.push("metadata.homepage must be a valid URL"); }
    }
    if (id && name && version) metadata = { id, name, version, ...(description ? { description } : {}), ...(homepage ? { homepage } : {}) };
  }

  const requiresRaw = object(root.requires);
  let requirements: PluginManifest["requires"] | undefined;
  if (root.requires !== undefined) {
    if (!requiresRaw) errors.push("requires must be an object");
    else {
      rejectUnknown(requiresRaw, ["bivy"], "requires", errors);
      const bivy = requiredString(requiresRaw.bivy, "requires.bivy", errors, 120);
      if (bivy && !validRange(bivy)) errors.push("requires.bivy must be a valid semantic-version range such as >=0.10.0 <0.11.0");
      if (bivy && validRange(bivy)) requirements = { bivy };
    }
  }

  const contributesRaw = object(root.contributes);
  let agents: PluginAgentContribution[] = [];
  if (!contributesRaw) errors.push("contributes must be an object");
  else {
    rejectUnknown(contributesRaw, ["agents"], "contributes", errors);
    if (!Array.isArray(contributesRaw.agents) || contributesRaw.agents.length === 0 || contributesRaw.agents.length > 20) {
      errors.push("contributes.agents must be a non-empty list of at most 20 agents");
    } else {
      agents = contributesRaw.agents.map((agent, index) => parseAgent(agent, index, errors)).filter((agent): agent is PluginAgentContribution => Boolean(agent));
      const ids = new Set<string>();
      for (const agent of agents) {
        if (ids.has(agent.id)) errors.push(`contributes.agents contains duplicate id ${agent.id}`);
        ids.add(agent.id);
      }
    }
  }

  if (errors.length || !metadata) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      apiVersion: PLUGIN_API_VERSION,
      kind: PLUGIN_KIND,
      metadata,
      ...(requirements ? { requires: requirements } : {}),
      contributes: { agents },
    },
  };
}

export function parsePluginManifest(text: string): PluginManifestResult {
  try {
    return validatePluginManifest(parseYaml(text, { uniqueKeys: true }));
  } catch (error) {
    return { ok: false, errors: [`YAML/JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** Compare a validated manifest's declared Bivy range with a running version. */
export function checkPluginCompatibility(manifest: PluginManifest, currentVersion: string): PluginCompatibilityResult {
  const requiredRange = manifest.requires?.bivy;
  if (!valid(currentVersion)) {
    return {
      compatible: false,
      currentVersion,
      ...(requiredRange ? { requiredRange } : {}),
      message: `Running Bivy version ${currentVersion} is not a valid semantic version`,
    };
  }
  if (!requiredRange) {
    return {
      compatible: true,
      currentVersion,
      message: "Manifest does not declare requires.bivy; compatibility is not pinned",
    };
  }
  const parsedCurrent = parseSemver(currentVersion);
  const stableCurrent = parsedCurrent ? `${parsedCurrent.major}.${parsedCurrent.minor}.${parsedCurrent.patch}` : currentVersion;
  // Staging builds use X.Y.Z-staging.N. Plugin compatibility tracks the API at
  // X.Y.Z, so a prerelease build of that exact source line may satisfy a stable
  // lower bound such as >=X.Y.Z.
  const compatible = satisfies(currentVersion, requiredRange, { includePrerelease: true })
    || (stableCurrent !== currentVersion && satisfies(stableCurrent, requiredRange));
  return {
    compatible,
    currentVersion,
    requiredRange,
    message: compatible
      ? `Bivy ${currentVersion} satisfies ${requiredRange}`
      : `Plugin requires Bivy ${requiredRange}, but this node runs ${currentVersion}`,
  };
}

/** Recommend a bounded range for manifests scaffolded by this Bivy build. */
export function recommendedBivyRange(currentVersion: string): string {
  const parsed = parseSemver(currentVersion);
  if (!parsed) throw new Error(`Cannot generate a compatibility range from invalid Bivy version ${currentVersion}`);
  return `>=${parsed.major}.${parsed.minor}.${parsed.patch} <${parsed.major}.${parsed.minor + 1}.0`;
}
