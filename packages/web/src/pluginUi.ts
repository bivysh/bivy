// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// What the machine's plugins add to the app itself, declared as data in their
// manifests: composer actions (a button that writes a prompt) and session
// panels (a tab that shows one of the plugin's widgets). Read from the machine
// when it connects and whenever the app comes back to the foreground, so a
// plugin an agent just installed shows up without a reload.
import { useEffect, useState } from "react";
import { controller, useAppState } from "./store/useStore.js";

export interface PluginAction {
  /** `<plugin id>/<action id>`: unique on the machine. */
  key: string;
  /** The plugin's display name. */
  plugin: string;
  label: string;
  description?: string;
  prompt: string;
  send?: boolean;
}

export interface PluginPanel {
  key: string;
  plugin: string;
  title: string;
  widget: string;
  data?: Record<string, unknown>;
}

export interface PluginUi { actions: PluginAction[]; panels: PluginPanel[] }

const EMPTY: PluginUi = { actions: [], panels: [] };
let cached: { nodeId: string; ui: PluginUi } | null = null;
const listeners = new Set<(ui: PluginUi) => void>();
let inFlight: Promise<void> | null = null;

function publish(nodeId: string, ui: PluginUi): void {
  cached = { nodeId, ui };
  for (const listener of listeners) listener(ui);
}

/** Ask the connected machine again; a machine without the command reads as none. */
export function refreshPluginUi(): Promise<void> {
  const { connection } = controller.store.getState();
  const nodeId = connection.currentNodeId ?? "";
  if (connection.status !== "online") return Promise.resolve();
  inFlight ??= controller.pluginCommand("plugins.ui").then(
    (reply) => {
      const raw = reply as Partial<PluginUi>;
      publish(nodeId, { actions: Array.isArray(raw.actions) ? raw.actions : [], panels: Array.isArray(raw.panels) ? raw.panels : [] });
    },
    () => publish(nodeId, EMPTY),
  ).finally(() => { inFlight = null; });
  return inFlight;
}

export function usePluginUi(): PluginUi {
  const { connection } = useAppState();
  const nodeId = connection.currentNodeId ?? "";
  const online = connection.status === "online";
  const [ui, setUi] = useState<PluginUi>(() => (cached?.nodeId === nodeId ? cached.ui : EMPTY));
  useEffect(() => {
    listeners.add(setUi);
    return () => { listeners.delete(setUi); };
  }, []);
  useEffect(() => {
    if (cached?.nodeId !== nodeId) setUi(EMPTY);
    if (!online) return;
    void refreshPluginUi();
    const onVisible = () => { if (document.visibilityState === "visible") void refreshPluginUi(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [nodeId, online]);
  return ui;
}
