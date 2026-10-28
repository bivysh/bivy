// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// What installed plugins contribute besides agents — widgets, tools, themes,
// guides — flattened across plugins. One function for every type: a name that
// two plugins both claim is reported and neither copy is used, the same rule as
// for agents (store.ts), so install order never decides behavior.
import fs from "node:fs";
import path from "node:path";
import { currentBivyVersion } from "../app-version.js";
import { defaultDataDir } from "../data-dir.js";
import type { PluginGuideContribution, PluginThemeContribution, PluginToolContribution, PluginWidgetContribution } from "../plugin-sdk/index.js";
import { listInstalledPlugins } from "./store.js";

export interface Contributions {
  widgets: PluginWidgetContribution;
  tools: PluginToolContribution;
  themes: PluginThemeContribution;
  guides: PluginGuideContribution;
}
export type ContributionKey = keyof Contributions;

export interface Installed<T> {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  /** The installed plugin's directory; its files live here. */
  dir: string;
  item: T;
}

const NAME_OF: { [K in ContributionKey]: (item: Contributions[K]) => string } = {
  widgets: (widget) => widget.id,
  tools: (tool) => tool.name,
  themes: (theme) => theme.id,
  guides: (guide) => guide.topic,
};

export function installedContributions<K extends ContributionKey>(
  key: K,
  dataDir = defaultDataDir(),
  bivyVersion = currentBivyVersion(),
): { items: Installed<Contributions[K]>[]; errors: string[] } {
  const items: Installed<Contributions[K]>[] = [];
  const errors: string[] = [];
  const owners = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const plugin of listInstalledPlugins(dataDir, bivyVersion)) {
    if (!plugin.manifest || plugin.errors.length) continue;
    for (const item of (plugin.manifest.contributes[key] ?? []) as Contributions[K][]) {
      const name = NAME_OF[key](item);
      const owner = owners.get(name);
      if (owner !== undefined) {
        errors.push(`${plugin.id}: ${key.slice(0, -1)} ${name} is also provided by ${items[owner]!.pluginId}; neither is used`);
        conflicted.add(name);
        continue;
      }
      owners.set(name, items.length);
      items.push({ pluginId: plugin.manifest.metadata.id, pluginName: plugin.manifest.metadata.name, pluginVersion: plugin.manifest.metadata.version, dir: plugin.path, item });
    }
  }
  return { items: items.filter((entry) => !conflicted.has(NAME_OF[key](entry.item))), errors };
}

export function findContribution<K extends ContributionKey>(key: K, name: string, dataDir = defaultDataDir()): Installed<Contributions[K]> | undefined {
  return installedContributions(key, dataDir).items.find((entry) => NAME_OF[key](entry.item) === name);
}

/** A widget page a plugin provides, bounded like a workspace widget. */
export const MAX_PLUGIN_WIDGET_BYTES = 2 * 1024 * 1024;

export function readPluginWidget(name: string, dataDir = defaultDataDir()): { html: string; plugin: string; version: string; name: string } {
  const found = findContribution("widgets", name, dataDir);
  if (!found) throw new Error(`No plugin on this machine provides a widget called "${name}".`);
  const file = path.join(found.dir, found.item.entry);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`The widget "${name}" is missing from its plugin.`);
  if (stat.size > MAX_PLUGIN_WIDGET_BYTES) throw new Error(`The widget "${name}" is too large to run.`);
  return { html: fs.readFileSync(file, "utf8"), plugin: found.pluginId, version: found.pluginVersion, name: found.item.name };
}
