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
  answer(session: TSession, requestId: string, input: SessionControlMessage): void;
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
      const session = ports.resolve(input.sessionId);
      const requestId = String(input.requestId ?? "");
      if (!session || !requestId) {
        return ctx.reply({ type: "session.question.answer.error", httpStatus: 404, error: "No matching session/question" });
      }
      ports.answer(session, requestId, input);
      ctx.reply({ type: "session.question.answer.result", ok: true, requestId });
    },
  };
}
