// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// What the app may change about this machine's plugins: remove one, and choose
// or clear the plugin theme. Installing stays with agents and the CLI, which
// can read what they install; the app only manages what is already there.
import type { CommandEntries } from "../protocol/command-registry.js";

interface PluginCommand { kind: string; requestId?: unknown; [key: string]: unknown }

export interface PluginCommandDeps {
  remove(id: string): boolean;
  /** Choose a theme by id, or clear the choice with null. Throws for an unknown id. */
  setTheme(id: string | null): void;
}

export function createPluginCommands(deps: PluginCommandDeps): CommandEntries<PluginCommand> {
  const operations: Record<string, (msg: PluginCommand) => object> = {
    "plugins.remove": (msg) => {
      const id = String(msg.id ?? "");
      if (!deps.remove(id)) throw new Error(`No plugin called ${id} is installed.`);
      return { removed: id };
    },
    "plugins.theme": (msg) => {
      const id = typeof msg.id === "string" && msg.id ? msg.id : null;
      deps.setTheme(id);
      return { theme: id };
    },
  };
  return Object.fromEntries(Object.entries(operations).map(([kind, run]) => [kind, (msg, ctx) => {
    try {
      ctx.reply({ type: `${kind}.ok`, requestId: msg.requestId, ...run(msg) });
    } catch (error) {
      ctx.reply({ type: `${kind}.error`, requestId: msg.requestId, httpStatus: 400, error: (error as Error).message });
    }
  }]));
}
