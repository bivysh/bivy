// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Versioned, declarative Bivy plugin manifest.
 *
 * A manifest never executes code inside the daemon. What a plugin contributes
 * is data or a separate process:
 *   - agents: process agents are ordinary child processes; ACP agents are
 *     launched through Bivy's existing out-of-process ACP bridge;
 *   - widgets: HTML pages that run sandboxed inside chat messages;
 *   - tools: commands run as child processes with JSON in and out;
 *   - themes: a palette for the app;
 *   - guides: markdown playbooks agents read with `bivy guide`.
 * Adding a contribution type is a parser below and a row in CONTRIBUTION_TYPES.
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
    /** Fresh-launch args for an agent that accepts a host-assigned session id. */
    newArgs?: string[];
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

export interface PluginWidgetContribution {
  id: string;
  name: string;
  description?: string;
  /** The page, relative to the plugin directory. */
  entry: string;
}

/** One input field of a tool, in the same shape as Bivy's own command tools. */
export interface PluginToolInputField {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
}

export interface PluginToolContribution {
  name: string;
  description: string;
  input?: Record<string, PluginToolInputField>;
  /** Run with `{plugin}` in args replaced by the installed plugin's directory. */
  command: string;
  args?: string[];
  timeoutSeconds?: number;
  /** Chat widgets may call it too (`bivy.call`), not only agents. */
  widgets?: boolean;
}

export const THEME_COLORS = ["background", "foreground", "accent", "selection", "muted", "red", "green", "yellow", "blue", "magenta", "cyan", "orange"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

export interface PluginThemeContribution {
  id: string;
  name: string;
  mode?: "light" | "dark";
  colors: Partial<Record<ThemeColor, string>> & { background: string; foreground: string };
}

export interface PluginGuideContribution {
  topic: string;
  /** Markdown with a `# Title` line and a `Summary: …` line, relative to the plugin directory. */
  file: string;
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
    widgets?: PluginWidgetContribution[];
    tools?: PluginToolContribution[];
    themes?: PluginThemeContribution[];
    guides?: PluginGuideContribution[];
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
      rejectUnknown(value, ["args", "newArgs"], `${at}.resume`, errors);
      const resumeArgs = stringList(value.args, `${at}.resume.args`, errors) ?? [];
      const newArgs = stringList(value.newArgs, `${at}.resume.newArgs`, errors);
      if (!resumeArgs.some((arg) => arg.includes("{id}"))) errors.push(`${at}.resume.args must contain an {id} placeholder`);
      if (newArgs && !newArgs.some((arg) => arg.includes("{id}"))) errors.push(`${at}.resume.newArgs must contain an {id} placeholder`);
      resume = { args: resumeArgs, ...(newArgs ? { newArgs } : {}) };
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

/** Validate one `adapter` block. Plugin manifests and node `config.yaml` agents
 *  share it, so an agent is described the same way wherever it is declared. */
export function parseAgentAdapter(value: unknown, at: string, errors: string[]): ProcessAgentAdapter | AcpAgentAdapter | undefined {
  const raw = object(value);
  if (!raw) { errors.push(`${at} must be an object`); return undefined; }
  if (raw.kind === "process") return parseProcessAdapter(raw, at, errors);
  if (raw.kind === "acp") return parseAcpAdapter(raw, at, errors);
  errors.push(`${at}.kind must be process or acp`);
  return undefined;
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
  const adapter = parseAgentAdapter(raw.adapter, `${at}.adapter`, errors);
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

/** A file inside the plugin directory: relative, no `..`, no backslashes. */
function relativeFile(value: unknown, at: string, errors: string[], extensions: readonly string[]): string | undefined {
  const file = requiredString(value, at, errors, 200);
  if (!file) return undefined;
  if (file.startsWith("/") || file.includes("\\") || file.includes("\0") || file.split("/").some((part) => part === ".." || part === "")) {
    errors.push(`${at} must be a relative path inside the plugin directory`);
    return undefined;
  }
  if (!extensions.some((ext) => file.toLowerCase().endsWith(ext))) {
    errors.push(`${at} must end in ${extensions.join(" or ")}`);
    return undefined;
  }
  return file;
}

function slug(value: unknown, at: string, errors: string[]): string | undefined {
  const id = requiredString(value, at, errors, 48)?.toLowerCase();
  if (id && !ID_RE.test(id)) {
    errors.push(`${at} must be a lowercase slug (2-48 characters)`);
    return undefined;
  }
  return id;
}

function parseWidget(raw: Record<string, unknown>, at: string, errors: string[]): PluginWidgetContribution | undefined {
  rejectUnknown(raw, ["id", "name", "description", "entry"], at, errors);
  const id = slug(raw.id, `${at}.id`, errors);
  const name = requiredString(raw.name, `${at}.name`, errors, 120);
  const description = optionalString(raw.description, `${at}.description`, errors, 500);
  const entry = relativeFile(raw.entry, `${at}.entry`, errors, [".html", ".htm"]);
  if (!id || !name || !entry) return undefined;
  return { id, name, ...(description ? { description } : {}), entry };
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const INPUT_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

function parseTool(raw: Record<string, unknown>, at: string, errors: string[]): PluginToolContribution | undefined {
  rejectUnknown(raw, ["name", "description", "input", "command", "args", "timeoutSeconds", "widgets"], at, errors);
  const name = requiredString(raw.name, `${at}.name`, errors, 64);
  if (name && !TOOL_NAME_RE.test(name)) errors.push(`${at}.name must be lowercase letters, digits and underscores (2-64 characters)`);
  const description = requiredString(raw.description, `${at}.description`, errors, 1000);
  const command = requiredString(raw.command, `${at}.command`, errors, 500);
  if (command?.includes("\0")) errors.push(`${at}.command must not contain NUL bytes`);
  const args = stringList(raw.args, `${at}.args`, errors);
  let timeoutSeconds: number | undefined;
  if (raw.timeoutSeconds !== undefined) {
    timeoutSeconds = Number(raw.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) errors.push(`${at}.timeoutSeconds must be an integer from 1 to 300`);
  }
  if (raw.widgets !== undefined && typeof raw.widgets !== "boolean") errors.push(`${at}.widgets must be true or false`);
  let input: Record<string, PluginToolInputField> | undefined;
  if (raw.input !== undefined) {
    const fields = object(raw.input);
    if (!fields || Object.keys(fields).length > 32) errors.push(`${at}.input must be an object of at most 32 fields`);
    else {
      input = {};
      for (const [key, value] of Object.entries(fields)) {
        const fieldAt = `${at}.input.${key}`;
        const field = object(value);
        if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || !field) { errors.push(`${fieldAt} must be an object under a simple name`); continue; }
        rejectUnknown(field, ["type", "description", "required"], fieldAt, errors);
        if (!INPUT_TYPES.has(String(field.type))) { errors.push(`${fieldAt}.type must be one of ${[...INPUT_TYPES].join(", ")}`); continue; }
        const fieldDescription = optionalString(field.description, `${fieldAt}.description`, errors, 500);
        input[key] = { type: field.type as PluginToolInputField["type"], ...(fieldDescription ? { description: fieldDescription } : {}), ...(field.required === true ? { required: true } : {}) };
      }
    }
  }
  if (!name || !TOOL_NAME_RE.test(name) || !description || !command) return undefined;
  return {
    name, description, command,
    ...(input ? { input } : {}),
    ...(args ? { args } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
    ...(raw.widgets === true ? { widgets: true } : {}),
  };
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseTheme(raw: Record<string, unknown>, at: string, errors: string[]): PluginThemeContribution | undefined {
  rejectUnknown(raw, ["id", "name", "mode", "colors"], at, errors);
  const id = slug(raw.id, `${at}.id`, errors);
  const name = requiredString(raw.name, `${at}.name`, errors, 120);
  if (raw.mode !== undefined && raw.mode !== "light" && raw.mode !== "dark") errors.push(`${at}.mode must be light or dark`);
  const colorsRaw = object(raw.colors);
  const colors: Partial<Record<ThemeColor, string>> = {};
  if (!colorsRaw) errors.push(`${at}.colors must be an object`);
  else {
    rejectUnknown(colorsRaw, THEME_COLORS, `${at}.colors`, errors);
    for (const key of THEME_COLORS) {
      const value = colorsRaw[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !COLOR_RE.test(value)) errors.push(`${at}.colors.${key} must be a #rgb or #rrggbb color`);
      else colors[key] = value;
    }
    if (!colors.background || !colors.foreground) errors.push(`${at}.colors needs background and foreground`);
  }
  if (!id || !name || !colors.background || !colors.foreground) return undefined;
  return { id, name, ...(raw.mode ? { mode: raw.mode as "light" | "dark" } : {}), colors: colors as PluginThemeContribution["colors"] };
}

function parseGuide(raw: Record<string, unknown>, at: string, errors: string[]): PluginGuideContribution | undefined {
  rejectUnknown(raw, ["topic", "file"], at, errors);
  const topic = slug(raw.topic, `${at}.topic`, errors);
  const file = relativeFile(raw.file, `${at}.file`, errors, [".md"]);
  if (!topic || !file) return undefined;
  return { topic, file };
}

/**
 * Every contribution type other than agents: its key, how many a plugin may
 * declare, how to parse one, and which field must be unique. Data, so a new
 * type is one row.
 */
const CONTRIBUTION_TYPES = [
  { key: "widgets", max: 20, parse: parseWidget, id: (v: PluginWidgetContribution) => v.id },
  { key: "tools", max: 50, parse: parseTool, id: (v: PluginToolContribution) => v.name },
  { key: "themes", max: 20, parse: parseTheme, id: (v: PluginThemeContribution) => v.id },
  { key: "guides", max: 20, parse: parseGuide, id: (v: PluginGuideContribution) => v.topic },
] as const;

export const CONTRIBUTION_KEYS = ["agents", ...CONTRIBUTION_TYPES.map((type) => type.key)] as const;

function parseList<T>(value: unknown, key: string, max: number, parse: (raw: Record<string, unknown>, at: string, errors: string[]) => T | undefined, idOf: (v: T) => string, errors: string[]): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max) {
    errors.push(`contributes.${key} must be a list of at most ${max} entries`);
    return undefined;
  }
  const out: T[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const at = `contributes.${key}[${index}]`;
    const raw = object(item);
    if (!raw) { errors.push(`${at} must be an object`); return; }
    const parsed = parse(raw, at, errors);
    if (!parsed) return;
    const id = idOf(parsed);
    if (ids.has(id)) errors.push(`contributes.${key} contains duplicate ${id}`);
    ids.add(id);
    out.push(parsed);
  });
  return out;
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
  const extra: Record<string, unknown[]> = {};
  if (!contributesRaw) errors.push("contributes must be an object");
  else {
    rejectUnknown(contributesRaw, CONTRIBUTION_KEYS, "contributes", errors);
    for (const type of CONTRIBUTION_TYPES) {
      const list = parseList(contributesRaw[type.key], type.key, type.max, type.parse as (raw: Record<string, unknown>, at: string, errors: string[]) => unknown, type.id as (v: unknown) => string, errors);
      if (list?.length) extra[type.key] = list;
    }
    const hasOther = Object.keys(extra).length > 0;
    if (contributesRaw.agents === undefined && hasOther) {
      // A plugin may contribute only widgets, tools, themes or guides.
    } else if (!Array.isArray(contributesRaw.agents) || (contributesRaw.agents.length === 0 && !hasOther) || contributesRaw.agents.length > 20) {
      errors.push(hasOther ? "contributes.agents must be a list of at most 20 agents" : "contributes must declare at least one agent, widget, tool, theme or guide");
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
      contributes: { agents, ...extra } as PluginManifest["contributes"],
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
  // The manifest contract is versioned by apiVersion, so a plugin keeps working
  // across Bivy minor releases; only a major release may break it.
  return `>=${parsed.major}.${parsed.minor}.${parsed.patch} <${parsed.major + 1}.0.0`;
}
