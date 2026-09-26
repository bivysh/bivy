// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { CommandEntries } from "../protocol/command-registry.js";
import { deviceFrom, type PresenceBook, type SessionPresence } from "../session/presence.js";

export interface PresenceMessage {
  kind: string;
  sessionId?: unknown;
  requestId?: unknown;
  [key: string]: unknown;
}

/** Device handoff presence, shared by relay and HTTP: read a session's driver
 * and carried-over draft, and publish this device's unsent draft. */
export function createPresenceCommands(book: PresenceBook, publish: (presence: SessionPresence) => void): CommandEntries<PresenceMessage> {
  return {
    "session.presence.get"(input, ctx) {
      const requestId = typeof input.requestId === "string" ? input.requestId : undefined;
      ctx.reply({ type: "session.presence.get.ok", requestId, presence: book.get(String(input.sessionId)) });
    },
    "session.presence.draft"(input, ctx) {
      const requestId = typeof input.requestId === "string" ? input.requestId : undefined;
      const device = deviceFrom(input.device);
      if (!device) return ctx.reply({ type: "session.presence.draft.error", httpStatus: 400, requestId, error: "Missing device" });
      publish(book.draft(String(input.sessionId), device, String(input.text ?? "")));
      ctx.reply({ type: "session.presence.draft.ok", requestId });
    },
  };
}
