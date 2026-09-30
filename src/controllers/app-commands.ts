// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import os from "node:os";
import type { AppManifest, AppPinState, ReviewCardMode, SessionApp, ShareDuration } from "../apps/types.js";
import type { CommandEntries } from "../protocol/command-registry.js";
import type { AppService } from "../apps/service.js";

interface AppCommand { kind: string; requestId?: unknown; [key: string]: unknown }
/** `machineRoot`: where servers are looked for before a session exists (the owner's home). */
export function createAppCommands(service: AppService, workspaceFor: (sessionId: string) => string | undefined, published: (app: SessionApp) => void = () => {}, machineRoot: () => string = os.homedir): CommandEntries<AppCommand> {
  const workspaceOf = (sessionId: string) => {
    const workspace = workspaceFor(sessionId);
    if (!workspace) throw new Error("Open the session on this machine before publishing an app.");
    return workspace;
  };
  const operations: Record<string, (msg: AppCommand) => unknown | Promise<unknown>> = {
    "apps.list": (msg) => service.list(typeof msg.sessionId === "string" ? msg.sessionId : undefined),
    "apps.publish": (msg) => {
      const sessionId = String(msg.sessionId);
      const app = service.publish(sessionId, workspaceOf(sessionId), msg.manifest as AppManifest);
      published(app);
      return { app };
    },
    // Without a session: servers anywhere in the owner's home, for a first session to open.
    "apps.offers": (msg) => typeof msg.sessionId === "string" ? service.offers(msg.sessionId, workspaceOf(msg.sessionId)) : service.machineOffers(machineRoot()),
    "apps.adopt": async (msg) => {
      const sessionId = String(msg.sessionId);
      const app = await service.adopt(sessionId, workspaceOf(sessionId), Number(msg.port));
      published(app);
      return { app };
    },
    "apps.open": (msg) => service.open(String(msg.sessionId), String(msg.appId), String(msg.viewId), typeof msg.returnTo === "string" ? msg.returnTo : undefined, msg.direct === true, typeof msg.scale === "number" ? msg.scale : undefined, typeof msg.path === "string" ? msg.path : undefined),
    "apps.shot": (msg) => service.shot(String(msg.sessionId), typeof msg.appId === "string" ? msg.appId : undefined, { widths: msg.widths as number[] | undefined, themes: msg.themes as ("light" | "dark")[] | undefined, path: typeof msg.path === "string" ? msg.path : undefined }),
    "apps.input": (msg) => service.act(String(msg.sessionId), typeof msg.target === "string" ? msg.target : undefined, msg.action),
    "apps.menu": (msg) => service.menu(String(msg.sessionId), typeof msg.target === "string" ? msg.target : undefined, msg.path),
    "apps.present": (msg) => service.present(String(msg.sessionId), { target: typeof msg.target === "string" ? msg.target : undefined, path: typeof msg.path === "string" ? msg.path : undefined, note: typeof msg.note === "string" ? msg.note : undefined }),
    "apps.showMe": (msg) => service.present(String(msg.sessionId), { target: typeof msg.appId === "string" ? msg.appId : undefined, trigger: "asked" }),
    "apps.mute": (msg) => service.mute(String(msg.sessionId)),
    "apps.reviewMode": (msg) => service.setReviewMode(String(msg.sessionId), String(msg.appId), msg.mode as ReviewCardMode),
    "apps.annotate": (msg) => service.annotate(String(msg.sessionId), msg as never),
    // A pin is made only once the person has actually sent the message the
    // marks went into, so nothing appears in the chat that they didn't send.
    "apps.pin": (msg) => service.pin(String(msg.sessionId), { appId: String(msg.appId), viewId: String(msg.viewId), words: typeof msg.words === "string" ? msg.words : "" }),
    "apps.pinState": (msg) => service.setPinState(String(msg.sessionId), String(msg.pinId), msg.state as AppPinState),
    "apps.clearNotes": (msg) => service.clearNotes(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    "apps.agentNotes": (msg) => service.setAgentNotes(String(msg.sessionId), String(msg.appId), msg.enabled === true),
    "apps.notes": (msg) => service.notes(String(msg.sessionId), { app: typeof msg.appId === "string" ? msg.appId : undefined, view: typeof msg.view === "string" ? msg.view : undefined, since: typeof msg.since === "number" ? msg.since : undefined }),
    "apps.logs": (msg) => service.logs(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    // The app UI passes exact IDs; `bivy app share` passes an app and/or view by ID or name.
    "apps.share": (msg) => {
      const options = { duration: msg.duration as ShareDuration | undefined, controls: msg.controls !== false };
      return typeof msg.viewId === "string" && typeof msg.appId === "string"
        ? service.share(String(msg.sessionId), msg.appId, msg.viewId, options)
        : service.shareView(String(msg.sessionId), { app: typeof msg.appId === "string" ? msg.appId : undefined, view: typeof msg.view === "string" ? msg.view : undefined, ...options });
    },
    "apps.unshare": (msg) => service.unshare(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    "apps.revoke": (msg) => service.revoke(String(msg.sessionId), String(msg.appId), String(msg.viewId)),
    "apps.remove": (msg) => { service.remove(String(msg.sessionId), String(msg.appId)); return { ok: true }; },
  };
  return Object.fromEntries(Object.entries(operations).map(([kind, execute]) => [kind, async (msg, ctx) => {
    try {
      ctx.reply({ type: `${kind}.ok`, requestId: msg.requestId, ...await execute(msg) as object });
      if (kind === "apps.publish" || kind === "apps.adopt" || kind === "apps.remove" || kind === "apps.reviewMode" || kind === "apps.agentNotes") ctx.broadcast({ type: "apps.changed", sessionId: msg.sessionId });
    } catch (error) {
      // Static filesystem errors can disclose host paths; keep those local.
      const message = error instanceof Error && !("code" in error) ? error.message : "Could not read the app directory. Check its path and permissions.";
      ctx.reply({ type: `${kind}.error`, requestId: msg.requestId, httpStatus: 400, error: message });
    }
  }]));
}
