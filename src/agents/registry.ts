// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import {
  describeAgentIntegrationOrigin,
  type AgentIntegration,
  type AgentIntegrationOrigin,
} from "./definition.js";

export interface AgentIntegrationConflict {
  id: string;
  retainedSource: string;
  rejectedSource: string;
  retainedOrigin?: AgentIntegrationOrigin;
  rejectedOrigin: AgentIntegrationOrigin;
}

/**
 * Ordered registry shared by maintained packages, node configuration, and
 * installed integration packages. Earlier registrations win; provenance is
 * explicit metadata rather than an implementation-specific branch.
 */
export class AgentRegistry<TInfo, TCreateOptions, TRuntime, TInstall = unknown> {
  private readonly entries = new Map<string, AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall>>();
  private readonly aliases = new Map<string, string>();
  private readonly conflicts: AgentIntegrationConflict[] = [];

  register(entry: AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall>): boolean {
    const rejectedSource = describeAgentIntegrationOrigin(entry.origin);
    const existing = this.entries.get(entry.id);
    if (existing) {
      this.conflicts.push({
        id: entry.id,
        retainedSource: describeAgentIntegrationOrigin(existing.origin),
        rejectedSource,
        retainedOrigin: existing.origin,
        rejectedOrigin: entry.origin,
      });
      return false;
    }
    const aliasTarget = this.aliases.get(entry.id);
    if (aliasTarget) {
      const retained = this.entries.get(aliasTarget);
      this.conflicts.push({
        id: entry.id,
        retainedSource: retained ? describeAgentIntegrationOrigin(retained.origin) : `alias for ${aliasTarget}`,
        rejectedSource,
        ...(retained ? { retainedOrigin: retained.origin } : {}),
        rejectedOrigin: entry.origin,
      });
      return false;
    }
    this.entries.set(entry.id, entry);
    for (const alias of entry.aliases ?? []) {
      const target = this.aliases.get(alias);
      if (target && target !== entry.id) {
        const retained = this.entries.get(target);
        this.conflicts.push({
          id: alias,
          retainedSource: retained ? describeAgentIntegrationOrigin(retained.origin) : `alias for ${target}`,
          rejectedSource,
          ...(retained ? { retainedOrigin: retained.origin } : {}),
          rejectedOrigin: entry.origin,
        });
        continue;
      }
      if (this.entries.has(alias) && alias !== entry.id) {
        this.conflicts.push({
          id: alias,
          retainedSource: describeAgentIntegrationOrigin(this.entries.get(alias)!.origin),
          rejectedSource,
          retainedOrigin: this.entries.get(alias)!.origin,
          rejectedOrigin: entry.origin,
        });
        continue;
      }
      this.aliases.set(alias, entry.id);
    }
    return true;
  }

  get(id: string): AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall> | undefined {
    return this.entries.get(this.aliases.get(id) ?? id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  list(): AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall>[] {
    return [...this.entries.values()];
  }

  diagnostics(): AgentIntegrationConflict[] {
    return [...this.conflicts];
  }
}
