// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// What a chat widget can ask of the machine its session runs on: its saved
// state, the page of a widget a plugin provides, and the tools plugins
// provide. The widget itself never reaches the node — it posts to the app, and
// the app sends these over the same authenticated channel as every other
// command.
import type { CommandEntries } from "../protocol/command-registry.js";
import type { WidgetStateStore } from "../widgets/state.js";

interface WidgetCommand { kind: string; requestId?: unknown; sessionId?: unknown; [key: string]: unknown }

export interface WidgetCommandDeps {
  store: WidgetStateStore;
  /** Run a plugin tool for a widget. Rejects with a sentence when there is none. */
  callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  /** The page of a widget a plugin provides, by name. */
  widgetSource(name: string): { html: string; plugin: string; version: string; name: string };
}

export function createWidgetCommands(deps: WidgetCommandDeps): CommandEntries<WidgetCommand> {
  const operations: Record<string, (sessionId: string, msg: WidgetCommand) => Promise<object> | object> = {
    "widgets.state.get": (sessionId) => ({ states: deps.store.all(sessionId) }),
    "widgets.state.set": (sessionId, msg) => ({ entry: deps.store.set(sessionId, String(msg.key ?? ""), msg.state) }),
    "widgets.source": (_sessionId, msg) => ({ widget: deps.widgetSource(String(msg.name ?? "")) }),
    "widgets.tool": async (sessionId, msg) => ({
      result: await deps.callTool(sessionId, String(msg.name ?? ""), msg.arguments && typeof msg.arguments === "object" ? (msg.arguments as Record<string, unknown>) : {}),
    }),
  };
  return Object.fromEntries(Object.entries(operations).map(([kind, run]) => [kind, async (msg, ctx) => {
    try {
      ctx.reply({ type: `${kind}.ok`, requestId: msg.requestId, ...await run(String(msg.sessionId ?? ""), msg) });
    } catch (error) {
      ctx.reply({ type: `${kind}.error`, requestId: msg.requestId, httpStatus: 400, error: (error as Error).message });
    }
  }]));
}
