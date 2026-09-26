// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export interface ClientCommandRoute {
  method: "post";
  path: string;
  kind: string;
}

/** Direct-mode adapters for operations whose canonical implementation is the
 * client command registry. Relay and HTTP now differ only in framing. */
export const CLIENT_COMMAND_ROUTES: readonly ClientCommandRoute[] = [
  ...["list", "publish", "offers", "adopt", "open", "logs", "shot", "input", "present", "showMe", "mute", "reviewMode", "annotate", "clearNotes", "share", "revoke", "remove"].map((action) => ({ method: "post" as const, path: `/api/apps/${action}`, kind: `apps.${action}` })),
  { method: "post", path: "/api/artifacts/list", kind: "artifacts.list" },
  { method: "post", path: "/api/auth/credentials/native-preview", kind: "credentials.native.preview" },
  { method: "post", path: "/api/auth/credentials/native-import", kind: "credentials.native.import" },
  { method: "post", path: "/api/session/pause", kind: "session.pause" },
  ...["get", "draft"].map((action) => ({ method: "post" as const, path: `/api/session/presence/${action}`, kind: `session.presence.${action}` })),
  { method: "post", path: "/api/session/resume", kind: "session.resume" },
  { method: "post", path: "/api/session/question/answer", kind: "session.question.answer" },
];
