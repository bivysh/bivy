// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { PluginPanel } from "../pluginUi.js";
import { Panel } from "./Panel.js";
import { Widget } from "./Widget.js";

/**
 * A session panel a plugin declared: one of its widgets, given the panel's
 * data, in the side pane on a wide screen and a sheet on a phone. It runs in
 * the same sandbox as a chat widget, and its tools run in this session's
 * workspace.
 */
export function PluginPanelView({ panel, sessionId, docked, onClose }: { panel: PluginPanel; sessionId: string; docked?: boolean; onClose: () => void }) {
  return (
    <Panel docked={docked} title={panel.title} onClose={onClose} autoFocusSearch={false} size="large">
      <div className="plugin-panel">
        <Widget
          key={`${sessionId}:${panel.key}`}
          spec={{ type: "widget", widget: panel.widget, id: `panel:${panel.key}`, data: panel.data ?? {} }}
          attachment={null}
          path={null}
          attrs={{}}
          sessionId={sessionId}
        />
        <p className="card-sub">From the {panel.plugin} plugin</p>
      </div>
    </Panel>
  );
}
