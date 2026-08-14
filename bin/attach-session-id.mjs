// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure session-id resolution for `bivy attach` (bin/bivy.mjs's cmdAttach),
// extracted so it's unit-testable without executing the CLI.
//
// Every runtime adapter injects BIVY_SESSION_ID into its agent's subprocess env
// (see src/runtime/session-env.ts) so `bivy attach <path>`, run from the agent's
// own shell, can resolve its session without being told the id. Pi
// (src/runtime/pi.ts) is the one exception: its agent loop runs in-process
// rather than under a subprocess Bivy controls, so it has no hook to inject
// BIVY_SESSION_ID into its own bash tool's env the way the other adapters do.
// The pi-coding-agent SDK's bash tool already exposes PI_SESSION_ID to every
// command it runs by default — and that id IS the Bivy session id for a pi
// session (PiSession.id reads the exact same SessionManager the SDK reads it
// from) — so it's accepted here as an equivalent fallback.
export function resolveAttachSessionId({ sessionFlag, env } = {}) {
  const flag = typeof sessionFlag === "string" ? sessionFlag.trim() : "";
  if (flag) return flag;
  const bivy = env?.BIVY_SESSION_ID?.trim?.();
  if (bivy) return bivy;
  const pi = env?.PI_SESSION_ID?.trim?.();
  if (pi) return pi;
  return undefined;
}
