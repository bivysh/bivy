// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppManifest, AppOffer, OpenAppViewResult, SessionApp, SessionAppOffersResult, SessionAppsResult, ShareAppViewResult } from "./types.js";
import { AppRegistry } from "./registry.js";
import { scanListeners } from "./listeners.js";

export interface AppPreviewProvider {
  readonly available?: boolean;
  open(id: string, returnTo?: string): string;
  share(id: string): ShareAppViewResult;
  revoke(id: string): void;
}

export interface AppTerminalProvider {
  start(input: { command: string; args: string[]; workspace: string; name: string }): Promise<string>;
  has(termId: string): boolean;
  close(termId: string): void;
}

/** Composes view providers; registry never spawns processes and the gateway
 * never knows about terminals. New providers can extend open/remove here. */
export class AppService {
  private terminalStarts = new Map<string, Promise<string>>();
  constructor(readonly registry: AppRegistry, readonly gateway: AppPreviewProvider | undefined, private readonly terminals: AppTerminalProvider, private readonly scan: (workspace: string) => Promise<AppOffer[]> = scanListeners) {}

  list(sessionId: string): SessionAppsResult { return { apps: this.registry.list(sessionId), previewAvailable: Boolean(this.gateway) && this.gateway?.available !== false }; }
  publish(sessionId: string, workspace: string, manifest: AppManifest) { return this.registry.publish(sessionId, workspace, manifest); }
  /** An agent turn changed files in this session's workspace. */
  turnChanged(sessionId: string): string[] { return this.registry.touch(sessionId); }
  /** Servers running in the workspace that this session doesn't preview yet. */
  async offers(sessionId: string, workspace: string): Promise<SessionAppOffersResult> {
    const claimed = this.registry.claimedPorts(sessionId);
    return { offers: (await this.scan(workspace)).filter((offer) => !claimed.has(offer.port)) };
  }
  /** Publish a detected server. Re-scanned so a client can't adopt an arbitrary port. */
  async adopt(sessionId: string, workspace: string, port: number): Promise<SessionApp> {
    const offer = (await this.offers(sessionId, workspace)).offers.find((item) => item.port === port);
    if (!offer) throw new Error(`Nothing in this session's workspace is listening on port ${port} any more.`);
    return this.registry.publish(sessionId, workspace, { version: 1, name: `${offer.command} · :${port}`.slice(0, 100), views: [{ kind: "web", name: `Port ${port}`, source: { kind: "service", port } }] });
  }
  async open(sessionId: string, appId: string, viewId: string, returnTo?: string): Promise<OpenAppViewResult> {
    const entry = this.registry.requireView(sessionId, appId, viewId);
    if (entry.view.kind === "web") {
      if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
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
  share(sessionId: string, appId: string, viewId: string): ShareAppViewResult {
    if (this.registry.requireView(sessionId, appId, viewId).view.kind !== "web") throw new Error("Only web views have preview links.");
    if (!this.gateway) throw new Error("Bivy's preview service is unavailable on this connection.");
    return this.gateway.share(viewId);
  }
  /** Ends every link, browser session and open connection for one view; the app stays. */
  revoke(sessionId: string, appId: string, viewId: string): { ok: true } {
    this.registry.requireView(sessionId, appId, viewId);
    this.gateway?.revoke(viewId);
    return { ok: true };
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
