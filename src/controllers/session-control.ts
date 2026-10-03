// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { CommandEntries } from "../protocol/command-registry.js";

export interface SessionControlMessage {
  kind: string;
  sessionId?: unknown;
  requestId?: unknown;
  [key: string]: unknown;
}

export interface SessionControlPorts<TSession> {
  resolve(sessionId: unknown): TSession | undefined;
  pause(session: TSession): void;
  resume(session: TSession): void;
  /** Settle a question its session asked. False when no such session asks
   *  here: neither an open chat nor a live `bivy run` (which has no TSession). */
  answer(sessionId: unknown, requestId: string, input: SessionControlMessage): boolean;
}

/** Canonical pause/resume/question handlers shared by relay and generated HTTP
 * adapters. Session lookup and runtime effects remain injected composition ports. */
export function createSessionControlCommands<TSession>(ports: SessionControlPorts<TSession>): CommandEntries<SessionControlMessage> {
  return {
    "session.pause"(input, ctx) {
      const session = ports.resolve(input.sessionId);
      if (!session) return ctx.reply({ type: "session.pause.error", httpStatus: 404, error: "No active session" });
      ports.pause(session);
      ctx.reply({ type: "session.pause.result", ok: true });
    },
    "session.resume"(input, ctx) {
      const session = ports.resolve(input.sessionId);
      if (!session) return ctx.reply({ type: "session.resume.error", httpStatus: 404, error: "No active session" });
      ports.resume(session);
      ctx.reply({ type: "session.resume.result", ok: true });
    },
    "session.question.answer"(input, ctx) {
      const requestId = String(input.requestId ?? "");
      if (!requestId || !ports.answer(input.sessionId, requestId, input)) {
        return ctx.reply({ type: "session.question.answer.error", httpStatus: 404, error: "No matching session/question" });
      }
      ctx.reply({ type: "session.question.answer.result", ok: true, requestId });
    },
  };
}
