// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Agent Skills every agent on this machine is offered, whatever agent it is.
 *
 * A skill is a folder with a `SKILL.md` (YAML front matter with `name` and
 * `description`, then instructions) and any files it refers to: the Agent
 * Skills format several agents read natively. Bivy collects them from two
 * places and hands every session the same short index, through the channel
 * its instructions already use:
 *
 * - `<data-dir>/skills/<name>/SKILL.md`: dropped in by hand or with
 *   `bivy skill install`. These win over a plugin's skill of the same name.
 * - an installed plugin's `contributes.skills`.
 *
 * The index carries only names and descriptions; an agent reads a skill when
 * a task calls for it, with `bivy skill show <name>` (or the `bivy_skill` MCP
 * tool). A skill is text an agent reads, never a permission.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultDataDir } from "./data-dir.js";
import { installedContributions } from "./plugins/contributions.js";

export const SKILL_FILE = "SKILL.md";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_INDEXED_SKILLS = 50;
const MAX_INDEX_DESCRIPTION = 300;
const MAX_SKILL_FILES = 500;
const MAX_SKILL_COPY_BYTES = 20 * 1024 * 1024;

export interface Skill {
  name: string;
  description: string;
  /** The folder holding SKILL.md and the files it refers to. */
  dir: string;
  /** "user" for `<data-dir>/skills`, otherwise the plugin's id. */
  source: string;
}

export function userSkillsDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "skills");
}

/** Front matter and body of a SKILL.md. Missing or malformed front matter
 *  leaves the description empty; the skill is still usable. */
export function parseSkillFile(text: string): { name?: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { description: "", body: text };
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch { /* treat as no front matter */ }
  return {
    ...(typeof meta.name === "string" ? { name: meta.name.trim() } : {}),
    description: typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "",
    body: text.slice(match[0].length),
  };
}

function readSkill(dir: string, name: string, source: string): Skill | undefined {
  const file = path.join(dir, SKILL_FILE);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined;
    return { name, description: parseSkillFile(fs.readFileSync(file, "utf8")).description, dir, source };
  } catch {
    return undefined;
  }
}

/** Every skill on this machine, by name; a user skill shadows a plugin's. */
export function listSkills(dataDir = defaultDataDir()): Skill[] {
  const byName = new Map<string, Skill>();
  const root = userSkillsDir(dataDir);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* none yet */ }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!NAME_RE.test(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const skill = readSkill(path.join(root, entry.name), entry.name, "user");
    if (skill) byName.set(skill.name, skill);
  }
  for (const { pluginId, dir, item } of installedContributions("skills", dataDir).items) {
    if (byName.has(item.name)) continue;
    const skill = readSkill(path.dirname(path.join(dir, item.file)), item.name, pluginId);
    if (skill) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

export function findSkill(name: string, dataDir = defaultDataDir()): Skill | undefined {
  return listSkills(dataDir).find((skill) => skill.name === name);
}

/** What `bivy skill show` prints: where the skill's files are, then its instructions. */
export function renderSkill(skill: Skill): string {
  const { body } = parseSkillFile(fs.readFileSync(path.join(skill.dir, SKILL_FILE), "utf8"));
  return `# Skill: ${skill.name}\n\nSkill folder: ${skill.dir}\nPaths in these instructions are relative to that folder.\n\n${body.trim()}\n`;
}

/** The skills as `/name` commands for the composer's menu, any agent. The
 *  client turns one into a prompt to use that skill (core's skillPrompt). */
export function skillCommands(skills: Skill[]): Array<{ name: string; description?: string; mode: "skill" }> {
  return skills.slice(0, MAX_INDEXED_SKILLS).map((skill) => ({
    name: `/${skill.name}`,
    ...(skill.description ? { description: skill.description.length > MAX_INDEX_DESCRIPTION ? `${skill.description.slice(0, MAX_INDEX_DESCRIPTION - 1)}…` : skill.description } : {}),
    mode: "skill",
  }));
}

/** The short list every session gets, or "" when there are no skills. */
export function skillsIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  const shown = skills.slice(0, MAX_INDEXED_SKILLS);
  const lines = shown.map((skill) => {
    const description = skill.description.length > MAX_INDEX_DESCRIPTION ? `${skill.description.slice(0, MAX_INDEX_DESCRIPTION - 1)}…` : skill.description;
    return `- ${skill.name}${description ? `: ${description}` : ""}`;
  });
  if (skills.length > shown.length) lines.push(`- …and ${skills.length - shown.length} more: \`bivy skill list\``);
  return [
    "Skills installed on this machine. When a task matches one, read it before you start: `bivy skill show <name>` " +
      "(or the `bivy_skill` tool) prints its instructions and the folder holding the files it refers to.",
    ...lines,
  ].join("\n");
}

/**
 * Install a skill folder (one holding SKILL.md) into `<data-dir>/skills/<name>`.
 * The name is the front matter's `name`, else the folder's. Regular files only,
 * no dot-entries or links, bounded; replaces an existing copy only with `force`.
 */
export function installSkill(from: string, opts: { dataDir?: string; force?: boolean; name?: string } = {}): Skill {
  const source = path.resolve(from);
  const skillFile = path.join(source, SKILL_FILE);
  if (!fs.statSync(skillFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`${source} has no ${SKILL_FILE}; a skill is a folder with one`);
  const parsed = parseSkillFile(fs.readFileSync(skillFile, "utf8"));
  const name = (opts.name ?? parsed.name ?? path.basename(source)).toLowerCase();
  if (!NAME_RE.test(name)) throw new Error(`Skill name "${name}" must be lowercase letters, digits and '-' (up to 64 characters)`);
  const root = userSkillsDir(opts.dataDir);
  const target = path.join(root, name);
  const existed = fs.existsSync(target);
  if (existed && !opts.force) throw new Error(`Skill ${name} is already installed; pass --force to replace it`);
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, `.${name}.tmp-`));
  try {
    let files = 0;
    let bytes = 0;
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const at = path.join(dir, entry.name);
        const out = path.join(temp, rel, entry.name);
        if (entry.isDirectory()) { fs.mkdirSync(out, { recursive: true }); walk(at, path.join(rel, entry.name)); continue; }
        if (!entry.isFile()) continue;
        if (++files > MAX_SKILL_FILES) throw new Error(`The skill folder has more than ${MAX_SKILL_FILES} files`);
        bytes += fs.statSync(at).size;
        if (bytes > MAX_SKILL_COPY_BYTES) throw new Error(`The skill folder is larger than ${MAX_SKILL_COPY_BYTES / 1024 / 1024} MB`);
        fs.copyFileSync(at, out);
      }
    };
    walk(source, "");
    if (existed) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return readSkill(target, name, "user")!;
}

export function removeSkill(name: string, dataDir = defaultDataDir()): boolean {
  if (!NAME_RE.test(name)) throw new Error(`Skill name "${name}" must be lowercase letters, digits and '-'`);
  const target = path.join(userSkillsDir(dataDir), name);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
