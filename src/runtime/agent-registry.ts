// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Ordered registry shared by built-in, configured, and plugin-contributed agents.
 *
 * The registry is deliberately ignorant of adapter implementations. A native
 * SDK runtime and an out-of-process manifest contribution both register the same
 * lifecycle hooks; only their factories differ.
 */
export interface AgentRegistryEntry<TInfo, TCreateOptions, TRuntime, TInstall = unknown> {
  id: string;
  aliases?: string[];
  visible: boolean;
  sourceLabel: string;
  describe(): TInfo;
  create?: (options: TCreateOptions) => TRuntime;
  install?: (prefix: string) => TInstall | undefined;
}

export interface AgentRegistryConflict {
  id: string;
  retainedSource: string;
  rejectedSource: string;
}

export class AgentRegistry<TInfo, TCreateOptions, TRuntime, TInstall = unknown> {
  private readonly entries = new Map<string, AgentRegistryEntry<TInfo, TCreateOptions, TRuntime, TInstall>>();
  private readonly aliases = new Map<string, string>();
  private readonly conflicts: AgentRegistryConflict[] = [];

  register(entry: AgentRegistryEntry<TInfo, TCreateOptions, TRuntime, TInstall>): boolean {
    const existing = this.entries.get(entry.id);
    if (existing) {
      this.conflicts.push({ id: entry.id, retainedSource: existing.sourceLabel, rejectedSource: entry.sourceLabel });
      return false;
    }
    const aliasTarget = this.aliases.get(entry.id);
    if (aliasTarget) {
      this.conflicts.push({
        id: entry.id,
        retainedSource: this.entries.get(aliasTarget)?.sourceLabel ?? `alias for ${aliasTarget}`,
        rejectedSource: entry.sourceLabel,
      });
      return false;
    }
    this.entries.set(entry.id, entry);
    for (const alias of entry.aliases ?? []) {
      const target = this.aliases.get(alias);
      if (target && target !== entry.id) {
        this.conflicts.push({
          id: alias,
          retainedSource: this.entries.get(target)?.sourceLabel ?? `alias for ${target}`,
          rejectedSource: entry.sourceLabel,
        });
        continue;
      }
      if (this.entries.has(alias) && alias !== entry.id) {
        this.conflicts.push({ id: alias, retainedSource: this.entries.get(alias)!.sourceLabel, rejectedSource: entry.sourceLabel });
        continue;
      }
      this.aliases.set(alias, entry.id);
    }
    return true;
  }

  get(id: string): AgentRegistryEntry<TInfo, TCreateOptions, TRuntime, TInstall> | undefined {
    return this.entries.get(this.aliases.get(id) ?? id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  list(): AgentRegistryEntry<TInfo, TCreateOptions, TRuntime, TInstall>[] {
    return [...this.entries.values()];
  }

  diagnostics(): AgentRegistryConflict[] {
    return [...this.conflicts];
  }
}
