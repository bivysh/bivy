// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/** Node-local store for declarative Bivy plugins. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { currentBivyVersion } from "../app-version.js";
import { checkWidgetScripts } from "../widgets/check.js";
import { defaultDataDir } from "../data-dir.js";
import {
  checkPluginCompatibility,
  DEFAULT_PLUGIN_MANIFEST_NAMES,
  parsePluginManifest,
  validatePluginManifest,
  type PluginAgentContribution,
  type PluginManifest,
} from "../plugin-sdk/index.js";

export const PLUGIN_MANIFEST_FILE = "manifest.json";
export const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;
/** Bounds on a plugin's files (widget pages, tool scripts, guides). */
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
/** Where an installed plugin came from, beside its files (dot-files are never copied from a plugin). */
export const PLUGIN_SOURCE_FILE = ".bivy-source.json";
/** Earlier copies of each plugin, kept when it is replaced, newest last. */
const SNAPSHOTS_DIR = ".snapshots";
const KEEP_SNAPSHOTS = 3;

export interface PluginSourceRecord {
  /** What to install from again: a `github:`/git source as written, or an absolute folder. */
  source: string;
  /** Content hash of what was installed (manifest and files), to tell whether the source changed. */
  hash: string;
  version: string;
  installedAt: string;
}

export interface PluginSnapshot { id: string; version: string; dir: string; takenAt: string }

export interface InstalledPlugin {
  id: string;
  path: string;
  manifest?: PluginManifest;
  errors: string[];
}

export interface InstalledAgentContribution {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  agent: PluginAgentContribution;
}

export interface InstalledAgentResult {
  agents: InstalledAgentContribution[];
  errors: string[];
}

export function pluginStoreDir(dataDir = defaultDataDir()): string {
  const override = process.env.BIVY_PLUGIN_DIR?.trim();
  return override ? path.resolve(override) : path.join(dataDir, "plugins");
}

function readBounded(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("manifest is not a regular file");
  if (stat.size > MAX_PLUGIN_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_PLUGIN_MANIFEST_BYTES} bytes`);
  return fs.readFileSync(file, "utf8");
}

/** Resolve either a manifest file or a plugin directory containing one. */
export function resolvePluginManifestPath(input: string): string {
  const candidate = path.resolve(input);
  let stat: fs.Stats;
  try { stat = fs.statSync(candidate); }
  catch { throw new Error(`Plugin manifest not found: ${candidate}`); }
  if (stat.isFile()) return candidate;
  if (!stat.isDirectory()) throw new Error(`Plugin path is neither a file nor directory: ${candidate}`);
  for (const name of DEFAULT_PLUGIN_MANIFEST_NAMES) {
    const file = path.join(candidate, name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* try next */ }
  }
  throw new Error(`No plugin manifest found in ${candidate} (looked for ${DEFAULT_PLUGIN_MANIFEST_NAMES.join(", ")})`);
}

export function readPluginManifest(input: string): { file: string; manifest: PluginManifest } {
  const file = resolvePluginManifestPath(input);
  const result = parsePluginManifest(readBounded(file));
  if (!result.ok || !result.manifest) throw new Error(result.errors.join("; "));
  return { file, manifest: result.manifest };
}

export function listInstalledPlugins(dataDir = defaultDataDir(), bivyVersion = currentBivyVersion()): InstalledPlugin[] {
  const root = pluginStoreDir(dataDir);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ id: "(store)", path: root, errors: [error instanceof Error ? error.message : String(error)] }];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry): InstalledPlugin => {
      const dir = path.join(root, entry.name);
      const file = path.join(dir, PLUGIN_MANIFEST_FILE);
      try {
        const raw = JSON.parse(readBounded(file)) as unknown;
        const result = validatePluginManifest(raw);
        if (!result.ok || !result.manifest) return { id: entry.name, path: dir, errors: result.errors };
        if (result.manifest.metadata.id !== entry.name) {
          return { id: entry.name, path: dir, errors: [`metadata.id ${result.manifest.metadata.id} does not match installed directory ${entry.name}`] };
        }
        const compatibility = checkPluginCompatibility(result.manifest, bivyVersion);
        if (!compatibility.compatible) {
          return { id: entry.name, path: dir, manifest: result.manifest, errors: [compatibility.message] };
        }
        return { id: entry.name, path: dir, manifest: result.manifest, errors: [] };
      } catch (error) {
        return { id: entry.name, path: dir, errors: [error instanceof Error ? error.message : String(error)] };
      }
    });
}

/**
 * Flatten valid installed agent contributions. Duplicate agent ids are rejected
 * across plugins rather than resolved by directory order.
 */
export function installedAgentContributions(dataDir = defaultDataDir(), bivyVersion = currentBivyVersion()): InstalledAgentResult {
  const agents: InstalledAgentContribution[] = [];
  const errors: string[] = [];
  const owners = new Map<string, string>();
  for (const plugin of listInstalledPlugins(dataDir, bivyVersion)) {
    if (!plugin.manifest || plugin.errors.length) {
      for (const error of plugin.errors) errors.push(`${plugin.id}: ${error}`);
      continue;
    }
    for (const agent of plugin.manifest.contributes.agents) {
      const owner = owners.get(agent.id);
      if (owner) {
        errors.push(`${plugin.id}: agent id ${agent.id} conflicts with plugin ${owner}; neither later contribution overrides an earlier one`);
        continue;
      }
      owners.set(agent.id, plugin.id);
      agents.push({
        pluginId: plugin.manifest.metadata.id,
        pluginName: plugin.manifest.metadata.name,
        pluginVersion: plugin.manifest.metadata.version,
        agent,
      });
    }
  }
  return { agents, errors };
}

/** Whether a manifest refers to files that must be installed with it. */
function needsFiles(manifest: PluginManifest): boolean {
  return Boolean(manifest.contributes.widgets?.length || manifest.contributes.tools?.length || manifest.contributes.guides?.length || manifest.contributes.skills?.length);
}

/**
 * Copy a plugin's directory into the store: regular files only (symlinks are
 * skipped, so nothing outside the directory comes along), dot-directories such
 * as .git left out, and the whole copy bounded.
 */
function copyPluginFiles(from: string, to: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const source = path.join(dir, entry.name);
      const target = path.join(to, rel, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        walk(source, path.join(rel, entry.name));
      } else if (entry.isFile()) {
        if (++files > MAX_PLUGIN_FILES) throw new Error(`Plugin directory has more than ${MAX_PLUGIN_FILES} files; keep the plugin in its own folder`);
        bytes += fs.statSync(source).size;
        if (bytes > MAX_PLUGIN_BYTES) throw new Error(`Plugin directory is larger than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB; keep the plugin in its own folder`);
        fs.copyFileSync(source, target);
      }
    }
  };
  walk(from, "");
}

/** The files install would copy, in a stable order (same rules as copyPluginFiles). */
function pluginFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(root, "");
  return out;
}

/** A content hash of what installing from `input` would put in the store. */
export function pluginSourceHash(input: string): { hash: string; manifest: PluginManifest } {
  const { file, manifest } = readPluginManifest(input);
  const hash = createHash("sha256").update(JSON.stringify(manifest));
  if (needsFiles(manifest)) {
    const root = path.dirname(file);
    for (const rel of pluginFiles(root)) hash.update(`\0${rel}\0`).update(fs.readFileSync(path.join(root, rel)));
  }
  return { hash: `sha256:${hash.digest("hex")}`, manifest };
}

export function readPluginSource(pluginDir: string): PluginSourceRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, PLUGIN_SOURCE_FILE), "utf8")) as Partial<PluginSourceRecord>;
    return typeof raw.source === "string" && typeof raw.hash === "string" ? raw as PluginSourceRecord : undefined;
  } catch {
    return undefined;
  }
}

function snapshotsOf(id: string, dataDir?: string): string {
  return path.join(pluginStoreDir(dataDir), SNAPSHOTS_DIR, id);
}

/** Earlier copies of a plugin, oldest first. */
export function listPluginSnapshots(id: string, dataDir = defaultDataDir()): PluginSnapshot[] {
  const root = snapshotsOf(id, dataDir);
  let names: string[];
  try { names = fs.readdirSync(root).filter((name) => /^\d{13}-/.test(name)).sort(); } catch { return []; }
  return names.map((name) => {
    const dir = path.join(root, name);
    let version = name.slice(14);
    try { version = (JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), "utf8")) as PluginManifest).metadata.version; } catch { /* keep the name's */ }
    return { id, version, dir, takenAt: new Date(Number(name.slice(0, 13))).toISOString() };
  });
}

/** Move a replaced copy into the snapshots, keeping the newest few. */
function keepSnapshot(id: string, from: string, version: string, dataDir?: string): void {
  const root = snapshotsOf(id, dataDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.renameSync(from, path.join(root, `${Date.now()}-${version.replace(/[^\w.+-]/g, "_")}`));
  const all = fs.readdirSync(root).filter((name) => /^\d{13}-/.test(name)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
}

/**
 * Put the newest snapshot back in place of the installed copy, which is
 * discarded (an update brings it back). Returns the versions involved.
 */
export function rollbackPlugin(id: string, dataDir = defaultDataDir()): { from: string; to: string } {
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error("Plugin id must be a lowercase slug (2-48 characters)");
  const snapshot = listPluginSnapshots(id, dataDir).at(-1);
  if (!snapshot) throw new Error(`No earlier copy of ${id} to go back to; one is kept each time it is updated or reinstalled`);
  const target = path.join(pluginStoreDir(dataDir), id);
  let from = "(not installed)";
  try { from = (JSON.parse(fs.readFileSync(path.join(target, PLUGIN_MANIFEST_FILE), "utf8")) as PluginManifest).metadata.version; } catch { /* missing or broken */ }
  const discard = `${target}.rollback-${process.pid}-${Date.now()}`;
  if (fs.existsSync(target)) fs.renameSync(target, discard);
  try {
    fs.renameSync(snapshot.dir, target);
  } catch (error) {
    if (fs.existsSync(discard)) fs.renameSync(discard, target);
    throw error;
  }
  fs.rmSync(discard, { recursive: true, force: true });
  return { from, to: snapshot.version };
}

/** Files the manifest names, which must be in the copy. */
function missingFiles(manifest: PluginManifest, dir: string): string[] {
  const named = [
    ...(manifest.contributes.widgets ?? []).map((widget) => widget.entry),
    ...(manifest.contributes.guides ?? []).map((guide) => guide.file),
    ...(manifest.contributes.skills ?? []).map((skill) => skill.file),
  ];
  return named.filter((file) => !fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile());
}

/**
 * Install (or with `force`, replace) a plugin. `source` records where it came
 * from so `bivy plugin outdated|update` can check it later; a replaced copy is
 * kept as a snapshot for `bivy plugin rollback` unless `snapshot` is false.
 */
export function installPlugin(input: string, opts: { dataDir?: string; force?: boolean; bivyVersion?: string; source?: string; snapshot?: boolean } = {}): { manifest: PluginManifest; path: string; replaced: boolean; previousVersion?: string } {
  const { file, manifest } = readPluginManifest(input);
  const compatibility = checkPluginCompatibility(manifest, opts.bivyVersion ?? currentBivyVersion());
  if (!compatibility.compatible) throw new Error(compatibility.message);
  const root = pluginStoreDir(opts.dataDir);
  const target = path.join(root, manifest.metadata.id);
  const existed = fs.existsSync(target);
  if (existed && !opts.force) throw new Error(`Plugin ${manifest.metadata.id} is already installed; pass --force to replace it`);

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(root, `.${manifest.metadata.id}.tmp-`));
  const backup = path.join(root, `.${manifest.metadata.id}.backup-${process.pid}-${Date.now()}`);
  try {
    if (needsFiles(manifest)) {
      copyPluginFiles(path.dirname(file), temp);
      const missing = missingFiles(manifest, temp);
      if (missing.length) throw new Error(`The manifest names files that are not in the plugin directory: ${missing.join(", ")}`);
      // A widget whose script cannot parse would show and do nothing.
      const broken = (manifest.contributes.widgets ?? []).flatMap((widget) => checkWidgetScripts(fs.readFileSync(path.join(temp, widget.entry), "utf8"), widget.entry));
      if (broken.length) throw new Error(`A widget's script does not parse: ${broken.join("; ")}`);
    }
    const output = path.join(temp, PLUGIN_MANIFEST_FILE);
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    if (opts.source) {
      const record: PluginSourceRecord = { source: opts.source, hash: pluginSourceHash(file).hash, version: manifest.metadata.version, installedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(temp, PLUGIN_SOURCE_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    }
    let previousVersion: string | undefined;
    if (existed) {
      try { previousVersion = (JSON.parse(fs.readFileSync(path.join(target, PLUGIN_MANIFEST_FILE), "utf8")) as PluginManifest).metadata.version; } catch { /* broken copy */ }
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      if (existed && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    if (existed && opts.snapshot !== false) {
      try { keepSnapshot(manifest.metadata.id, backup, previousVersion ?? "unknown", opts.dataDir); }
      catch (error) { console.warn(`[plugins] could not keep a snapshot of ${manifest.metadata.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (existed) fs.rmSync(backup, { recursive: true, force: true });
    return { manifest, path: target, replaced: existed, ...(previousVersion ? { previousVersion } : {}) };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    else fs.rmSync(backup, { recursive: true, force: true });
  }
}

export function removePlugin(id: string, dataDir = defaultDataDir()): boolean {
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error("Plugin id must be a lowercase slug (2-48 characters)");
  const target = path.join(pluginStoreDir(dataDir), id);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(snapshotsOf(id, dataDir), { recursive: true, force: true });
  return true;
}
