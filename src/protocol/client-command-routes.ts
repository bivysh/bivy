// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

export interface ClientCommandRoute {
  method: "post";
  path: string;
  kind: string;
}

/** Direct-mode adapters for operations whose canonical implementation is the
 * client command registry. Relay and HTTP now differ only in framing. */
export const CLIENT_COMMAND_ROUTES: readonly ClientCommandRoute[] = [
  ...["list", "publish", "offers", "adopt", "open", "logs", "requests", "request", "runRequest", "data", "serverLog", "shot", "input", "menu", "present", "scenarios", "showMe", "mute", "reviewMode", "annotate", "clearNotes", "agentNotes", "notes", "share", "unshare", "revoke", "remove"].map((action) => ({ method: "post" as const, path: `/api/apps/${action}`, kind: `apps.${action}` })),
  { method: "post", path: "/api/artifacts/list", kind: "artifacts.list" },
  ...["list", "read"].map((action) => ({ method: "post" as const, path: `/api/files/${action}`, kind: `files.${action}` })),
  { method: "post", path: "/api/access/get", kind: "access.get" },
  // Direct transport maps `widgets.state.get` to `/api/widgets/state.get` (first dot only).
  ...["state.get", "state.set", "tool"].map((action) => ({ method: "post" as const, path: `/api/widgets/${action}`, kind: `widgets.${action}` })),
  ...["list", "remove"].map((action) => ({ method: "post" as const, path: `/api/secrets/${action}`, kind: `secrets.${action}` })),
  { method: "post", path: "/api/tailnet/machines", kind: "tailnet.machines" },
  { method: "post", path: "/api/auth/credentials/native-preview", kind: "credentials.native.preview" },
  { method: "post", path: "/api/auth/credentials/native-import", kind: "credentials.native.import" },
  { method: "post", path: "/api/session/pause", kind: "session.pause" },
  { method: "post", path: "/api/session/fork", kind: "session.fork.local" },
  ...["get", "draft"].map((action) => ({ method: "post" as const, path: `/api/session/presence/${action}`, kind: `session.presence.${action}` })),
  { method: "post", path: "/api/session/resume", kind: "session.resume" },
  { method: "post", path: "/api/session/question/answer", kind: "session.question.answer" },
];
