// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppManifest, OpenAppViewResult, SessionAppsResult } from "./types.js";
import { AppRegistry } from "./registry.js";
import type { AppGateway } from "./gateway.js";

export interface AppTerminalProvider {
  start(input: { command: string; args: string[]; workspace: string; name: string }): Promise<string>;
  has(termId: string): boolean;
  close(termId: string): void;
}

/** Composes view providers; registry never spawns processes and the gateway
 * never knows about terminals. New providers can extend open/remove here. */
export class AppService {
  private terminalStarts = new Map<string, Promise<string>>();
  constructor(readonly registry: AppRegistry, readonly gateway: AppGateway | undefined, private readonly terminals: AppTerminalProvider) {}

  list(sessionId: string): SessionAppsResult { return { apps: this.registry.list(sessionId), previewAvailable: Boolean(this.gateway) }; }
  publish(sessionId: string, workspace: string, manifest: AppManifest) { return this.registry.publish(sessionId, workspace, manifest); }
  async open(sessionId: string, appId: string, viewId: string, returnTo?: string): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    if (entry.view.kind === "web") {
      if (!this.gateway) throw new Error("Web previews need a dedicated HTTPS preview domain. See docs/apps.md.");
      return { kind: "web", url: this.gateway.open(viewId, returnTo) };
    }
    if (entry.target.kind !== "terminal") throw new Error("Unsupported app view provider.");
    let pending = this.terminalStarts.get(viewId);
    if (pending) {
      const existing = await pending;
      this.registry.requireView(sessionId, appId, viewId);
      if (this.terminals.has(existing)) return { kind: "terminal", termId: existing };
      if (this.terminalStarts.get(viewId) === pending) this.terminalStarts.delete(viewId);
      return this.open(sessionId, appId, viewId);
    }
    // Single flight: repeated taps/retries attach to the same running program.
    pending = this.terminals.start({ ...entry.target, name: `${entry.app.name} · ${entry.view.name}` });
    this.terminalStarts.set(viewId, pending);
    try {
      const termId = await pending;
      if (!this.registry.getView(viewId)) { this.terminals.close(termId); throw new Error("App was removed while starting."); }
      return { kind: "terminal", termId };
    } catch (error) {
      if (this.terminalStarts.get(viewId) === pending) this.terminalStarts.delete(viewId);
      throw error;
    }
  }
  remove(sessionId: string, appId: string): void {
    const app = this.registry.require(sessionId, appId);
    this.registry.remove(sessionId, appId);
    for (const view of app.views) {
      this.gateway?.revoke(view.id);
      const pending = this.terminalStarts.get(view.id);
      this.terminalStarts.delete(view.id);
      if (pending) void pending.then((id) => this.terminals.close(id)).catch(() => {});
    }
  }
}
