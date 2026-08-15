// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The GitHub connect + App-manifest command cluster, extracted from server.ts's
// RELAY_COMMANDS (server.ts decomposition; same shape as controllers/
// session-control.ts, fork-commands.ts, credential-commands.ts). The GitHub
// device-flow and App-manifest logic stays in server.ts (it's woven into the
// control-plane + github-app vault); this controller is pure event-wiring over
// those operations, injected as deps, so the relay surface leaves the monolith.

import type { CommandEntries } from "../protocol/command-registry.js";

export interface GithubCommandMessage {
  kind: string;
  requestId?: unknown;
  [key: string]: unknown;
}

export interface GithubCommandDeps {
  /** Emit to the requesting device (server wraps `relay?.sendEvent`). */
  sendEvent(event: unknown): void;
  /** Begin the GitHub device-code connect flow → status to poll. */
  startGithubConnect(): Promise<Record<string, unknown>>;
  /** Poll the in-progress device-code flow → current status. */
  pollGithubConnect(): Promise<Record<string, unknown>>;
  /** Begin a GitHub App manifest creation (browser posts it to GitHub). */
  startAppManifest(input: { redirectBase: string; org?: string }): Promise<Record<string, unknown>>;
  /** Exchange the manifest code for the App's credentials (node-only). */
  completeAppManifest(input: { code: string; state: string }): Promise<Record<string, unknown>>;
  /** Connect an already-created GitHub App by id + private key. */
  connectExistingApp(input: { appId: string; privateKeyPem: string; nodeLabel?: string }): Promise<Record<string, unknown>>;
  /** Disconnect one App (by appId/hookId) or all when both are omitted. */
  disconnectGithubApp(input: { appId?: string; hookId?: string }): void;
}

export function createGithubCommands(deps: GithubCommandDeps): CommandEntries<GithubCommandMessage> {
  return {
    async "github.connect.start"() {
      deps.sendEvent({ type: "github.connect.status", ...(await deps.startGithubConnect()) });
    },
    async "github.connect.poll"() {
      deps.sendEvent({ type: "github.connect.status", ...(await deps.pollGithubConnect()) });
    },
    // GitHub App one-click, over the relay so it works on a headless/remote
    // node: the browser passes its own origin as the redirect base, submits
    // the manifest to GitHub itself, then relays the returned code back here —
    // the node alone exchanges it, so the private key never leaves it.
    async "github.app.manifest.start"(msg) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      try {
        const out = await deps.startAppManifest({
          redirectBase: String(msg.origin ?? ""),
          org: typeof msg.org === "string" ? msg.org : undefined,
        });
        deps.sendEvent({ type: "github.app.manifest.ready", requestId, ...out });
      } catch (error) {
        deps.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "github.app.manifest.code"(msg) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      try {
        const out = await deps.completeAppManifest({ code: String(msg.code ?? ""), state: String(msg.state ?? "") });
        deps.sendEvent({ type: "github.app.manifest.done", requestId, ...out });
      } catch (error) {
        deps.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    async "github.app.connect-existing"(msg) {
      // Reuse the manifest flow's done/error events so the existing GithubApp
      // phase machine + settings UI handle success/failure with no new plumbing.
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      try {
        const out = await deps.connectExistingApp({
          appId: String(msg.appId ?? ""),
          privateKeyPem: String(msg.privateKeyPem ?? ""),
          nodeLabel: typeof msg.nodeLabel === "string" ? msg.nodeLabel : undefined,
        });
        deps.sendEvent({ type: "github.app.manifest.done", requestId, ...out });
      } catch (error) {
        deps.sendEvent({ type: "github.app.manifest.error", requestId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    "github.app.disconnect"(msg) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      // appId (or hookId, for a stale app with no App ID) scopes the disconnect to
      // one app; both omitted = disconnect them all.
      const appId = typeof msg.appId === "string" && msg.appId.trim() ? msg.appId.trim() : undefined;
      const hookId = typeof msg.hookId === "string" && msg.hookId.trim() ? msg.hookId.trim() : undefined;
      deps.disconnectGithubApp({ appId, hookId });
      deps.sendEvent({ type: "github.app.disconnected", requestId, ok: true, appId, hookId });
    },
  };
}
