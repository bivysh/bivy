// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A kit is a whole Bivy setup as one folder (usually a git repository): the
// plugins someone uses and the theme they picked. `bivy kit export` writes the
// plugins installed on this machine into one; `bivy kit apply` installs one
// someone shared. A kit adds no new capability — every piece is an ordinary
// plugin — so it is only a list, and applying it is installing each entry.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { selectedThemeId } from "../machine-theme.js";
import { installPlugin, listInstalledPlugins, PLUGIN_MANIFEST_FILE } from "./store.js";

export const KIT_FILE = "bivy.kit.yaml";
const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;

export interface Kit {
  apiVersion: "bivy.sh/v1alpha1";
  kind: "Kit";
  metadata: { id: string; name: string; description?: string };
  /** Plugin folders, relative to the kit. */
  plugins: string[];
  /** A theme one of the plugins provides, chosen when the kit is applied. */
  theme?: string;
}

export function readKit(dir: string): Kit {
  const file = path.join(dir, KIT_FILE);
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"), { uniqueKeys: true });
  } catch (error) {
    throw new Error(`No readable ${KIT_FILE} in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const kit = raw as Partial<Kit> | null;
  const errors: string[] = [];
  if (kit?.apiVersion !== "bivy.sh/v1alpha1") errors.push("apiVersion must be bivy.sh/v1alpha1");
  if (kit?.kind !== "Kit") errors.push("kind must be Kit");
  if (!kit?.metadata || !ID_RE.test(String(kit.metadata.id)) || !kit.metadata.name) errors.push("metadata needs an id (lowercase slug) and a name");
  if (!Array.isArray(kit?.plugins) || !kit.plugins.length || kit.plugins.length > 50) errors.push("plugins must list 1-50 plugin folders");
  for (const entry of kit?.plugins ?? []) {
    if (typeof entry !== "string" || entry.startsWith("/") || entry.split("/").includes("..")) errors.push(`plugin ${JSON.stringify(entry)} must be a folder inside the kit`);
  }
  if (kit?.theme !== undefined && !ID_RE.test(String(kit.theme))) errors.push("theme must be a theme id");
  if (errors.length) throw new Error(`${KIT_FILE}: ${errors.join("; ")}`);
  return kit as Kit;
}

/** Install every plugin in the kit (replacing older copies). Returns their ids. */
export function applyKit(dir: string, dataDir: string): { kit: Kit; installed: string[] } {
  const kit = readKit(dir);
  const installed = kit.plugins.map((entry) => installPlugin(path.join(dir, entry), { dataDir, force: true }).manifest.metadata.id);
  return { kit, installed };
}

/** Write this machine's installed plugins, and its chosen theme, as a kit. */
export function exportKit(dir: string, dataDir: string, metadata: Kit["metadata"]): Kit {
  if (!ID_RE.test(metadata.id)) throw new Error("A kit id is a lowercase slug (2-48 characters).");
  if (fs.existsSync(path.join(dir, KIT_FILE))) throw new Error(`${path.join(dir, KIT_FILE)} already exists.`);
  const plugins = listInstalledPlugins(dataDir).filter((plugin) => plugin.manifest && !plugin.errors.length);
  if (!plugins.length) throw new Error("No plugins are installed to export.");
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  for (const plugin of plugins) {
    const target = path.join(dir, "plugins", plugin.id);
    fs.cpSync(plugin.path, target, { recursive: true, verbatimSymlinks: true });
    // The store keeps the canonical manifest as manifest.json; a kit carries the
    // editable YAML form people expect to find.
    fs.writeFileSync(path.join(target, "bivy.plugin.yaml"), stringifyYaml(plugin.manifest));
    fs.rmSync(path.join(target, PLUGIN_MANIFEST_FILE), { force: true });
  }
  const theme = selectedThemeId(dataDir);
  const kit: Kit = {
    apiVersion: "bivy.sh/v1alpha1",
    kind: "Kit",
    metadata,
    plugins: plugins.map((plugin) => `plugins/${plugin.id}`),
    ...(theme && plugins.some((plugin) => plugin.manifest!.contributes.themes?.some((entry) => entry.id === theme)) ? { theme } : {}),
  };
  fs.writeFileSync(path.join(dir, KIT_FILE), stringifyYaml(kit));
  return kit;
}
