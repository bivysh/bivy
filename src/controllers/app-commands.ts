// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppManifest, SessionApp } from "../apps/types.js";
import type { CommandEntries } from "../protocol/command-registry.js";
import type { AppService } from "../apps/service.js";

interface AppCommand { kind: string; requestId?: unknown; [key: string]: unknown }
export function createAppCommands(service: AppService, workspaceFor: (sessionId: string) => string | undefined, published: (app: SessionApp) => void = () => {}): CommandEntries<AppCommand> {
  const workspaceOf = (sessionId: string) => {
    const workspace = workspaceFor(sessionId);
    if (!workspace) throw new Error("Open the session on this machine before publishing an app.");
    return workspace;
  };
  const operations: Record<string, (msg: AppCommand) => unknown | Promise<unknown>> = {
    "apps.list": (msg) => service.list(String(msg.sessionId)),
    "apps.publish": (msg) => {
      const sessionId = String(msg.sessionId);
      const app = service.publish(sessionId, workspaceOf(sessionId), msg.manifest as AppManifest);
      published(app);
      return { app };
    },
    "apps.offers": (msg) => service.offers(String(msg.sessionId), workspaceOf(String(msg.sessionId))),
    "apps.adopt": async (msg) => {
      const sessionId = String(msg.sessionId);
      const app = await service.adopt(sessionId, workspaceOf(sessionId), Number(msg.port));
      published(app);
      return { app };
    },
    "apps.open": (msg) => service.open(String(msg.sessionId), String(msg.appId), String(msg.viewId), typeof msg.returnTo === "string" ? msg.returnTo : undefined),
    "apps.share": (msg) => service.share(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    "apps.revoke": (msg) => service.revoke(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    "apps.remove": (msg) => { service.remove(String(msg.sessionId), String(msg.appId)); return { ok: true }; },
  };
  return Object.fromEntries(Object.entries(operations).map(([kind, execute]) => [kind, async (msg, ctx) => {
    try {
      ctx.reply({ type: `${kind}.ok`, requestId: msg.requestId, ...await execute(msg) as object });
      if (kind === "apps.publish" || kind === "apps.adopt" || kind === "apps.remove") ctx.broadcast({ type: "apps.changed", sessionId: msg.sessionId });
    } catch (error) {
      // Static filesystem errors can disclose host paths; keep those local.
      const message = error instanceof Error && !("code" in error) ? error.message : "Could not read the app directory. Check its path and permissions.";
      ctx.reply({ type: `${kind}.error`, requestId: msg.requestId, httpStatus: 400, error: message });
    }
  }]));
}
