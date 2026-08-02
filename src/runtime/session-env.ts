// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared across every runtime adapter that spawns (or configures the spawn of) a
// subprocess for its agent: fold this into that subprocess's env so the agent's
// own shell can resolve its chat session without being told the id.
// `bivy attach <path>` (bin/bivy.mjs's cmdAttach) reads $BIVY_SESSION_ID to know
// which session to post an outbound attachment to — see
// claude-code.ts's BIVY_ATTACH_SYSTEM_PROMPT for the discoverability half of this
// feature (issue #288 shipped attach; issue #290 is making it universal). One
// helper, one env-var name, so a new adapter can't independently invent — or
// simply forget — its own convention.
//
// Used by claude-code.ts (spawnQuery), process.ts (ProcessSession.prompt), and
// protocol.ts (ProtocolSession.start). pi.ts is the one exception: Pi runs its
// agent loop in-process rather than spawning a subprocess Bivy controls, so it
// has no hook to inject this into its bash tool's env the same way — see the
// comment on PiSession.interactiveTuiCommand and bin/attach-session-id.mjs for
// how that gap is closed instead.
export function bivySessionEnv(sessionId: string): { BIVY_SESSION_ID: string } {
  return { BIVY_SESSION_ID: sessionId };
}
