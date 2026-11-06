// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Whether installed plugins changed at their source, and taking the change.
 * Nothing here runs on its own: `bivy plugin outdated` looks, `bivy plugin
 * update` installs, and every replaced copy stays as a snapshot for
 * `bivy plugin rollback`. A source pinned to a tag stays on that tag.
 */
import { defaultDataDir } from "../data-dir.js";
import { resolveSource } from "./source.js";
import { installPlugin, listInstalledPlugins, pluginSourceHash, readPluginSource } from "./store.js";

export type PluginUpdateStatus = "current" | "update" | "changed" | "no-source" | "error";

export interface PluginUpdateCheck {
  id: string;
  status: PluginUpdateStatus;
  installed?: string;
  available?: string;
  source?: string;
  error?: string;
}

type Resolve = typeof resolveSource;

/** Look at each installed plugin's recorded source (all of them, or `ids`). */
export function checkPluginUpdates(opts: { dataDir?: string; ids?: string[]; resolve?: Resolve } = {}): PluginUpdateCheck[] {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const resolve = opts.resolve ?? resolveSource;
  const plugins = listInstalledPlugins(dataDir).filter((plugin) => !opts.ids?.length || opts.ids.includes(plugin.id));
  for (const id of opts.ids ?? []) if (!plugins.some((plugin) => plugin.id === id)) throw new Error(`Plugin ${id} is not installed`);
  return plugins.map((plugin): PluginUpdateCheck => {
    const installed = plugin.manifest?.metadata.version;
    const record = readPluginSource(plugin.path);
    if (!record) return { id: plugin.id, status: "no-source", ...(installed ? { installed } : {}) };
    let fetched: ReturnType<Resolve> | undefined;
    try {
      fetched = resolve(record.source);
      const { hash, manifest } = pluginSourceHash(fetched.path);
      if (manifest.metadata.id !== plugin.id) throw new Error(`the source now holds plugin ${manifest.metadata.id}`);
      const available = manifest.metadata.version;
      const status: PluginUpdateStatus = hash === record.hash ? "current" : available !== (installed ?? record.version) ? "update" : "changed";
      return { id: plugin.id, status, source: record.source, ...(installed ? { installed } : {}), available };
    } catch (error) {
      return { id: plugin.id, status: "error", source: record.source, ...(installed ? { installed } : {}), error: error instanceof Error ? error.message : String(error) };
    } finally {
      fetched?.cleanup();
    }
  });
}

/** Reinstall one plugin from its recorded source; the replaced copy becomes a snapshot. */
export function updatePlugin(id: string, opts: { dataDir?: string; resolve?: Resolve } = {}): { id: string; from?: string; to: string } {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const plugin = listInstalledPlugins(dataDir).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`Plugin ${id} is not installed`);
  const record = readPluginSource(plugin.path);
  if (!record) throw new Error(`Bivy doesn't know where ${id} came from (installed before sources were recorded, or by a kit from a plain git URL); reinstall it once with bivy plugin install <source> --force`);
  const fetched = (opts.resolve ?? resolveSource)(record.source);
  try {
    const found = pluginSourceHash(fetched.path).manifest.metadata.id;
    if (found !== id) throw new Error(`${record.source} now holds plugin ${found}, not ${id}`);
    const result = installPlugin(fetched.path, { dataDir, force: true, source: record.source });
    return { id, ...(result.previousVersion ? { from: result.previousVersion } : {}), to: result.manifest.metadata.version };
  } finally {
    fetched.cleanup();
  }
}
