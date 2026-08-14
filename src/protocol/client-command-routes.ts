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
  { method: "post", path: "/api/session/pause", kind: "session.pause" },
  { method: "post", path: "/api/session/resume", kind: "session.resume" },
  { method: "post", path: "/api/session/question/answer", kind: "session.question.answer" },
];
