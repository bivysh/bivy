// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { withExactCapabilitySurface, type RuntimeCapabilities } from "../../runtime/types.js";

/**
 * The ONE capability table for Pi, shared by the real `PiRuntime` and the
 * `LazyPiRuntime` facade the registry hands out before the SDK is loaded.
 *
 * This module deliberately imports nothing from the pi SDK so the lazy facade
 * can use it without defeating its purpose. Keeping a single source of truth is
 * a correctness requirement, not tidiness: the daemon reads flags such as
 * `sessionRefIsPath` off whichever runtime object the registry returns — the
 * facade — *before* any session is opened. When the facade's copy of this table
 * drifted from the real one and lost `sessionRefIsPath`, the daemon treated every
 * pi resume ref as an opaque id, stripped the transcript path to its basename,
 * and pi created a brand-new empty session for every message sent to a closed
 * chat (the "sending to a closed session creates a new one" regression).
 */
export const PI_CAPABILITIES: RuntimeCapabilities = withExactCapabilitySurface({
  toolInterception: true,
  modelSelection: true,
  packages: true,
  resume: true,
  fork: false,
  // pi resumes by session-file path (under the node's sessions dir), so the
  // daemon applies its path-traversal guard to these refs.
  sessionRefIsPath: true,
  // pi's TUI ships with the node, so the chat<->TUI hand-off is always offered.
  interactiveTui: true,
  usageReporting: true,
  // pi can find a prior on-disk session by cwd + start time, so a `bivy run`
  // terminal with no pinned sessionId can still be continued as a governed chat.
  sessionDiscovery: true,
  // pi transcripts are structured messages that round-trip through the session
  // store, so a pi->pi fork is full fidelity (see exportForFork/importForFork).
  forkTransport: true,
  // pi can also stand up a session from portable {role,text} history, so a fork
  // FROM another agent INTO pi is a true replay, not a seeded summary.
  forkHistoryImport: true,
  // The pi-coding-agent SDK implements both explicitly: prompting mid-turn
  // with no streamingBehavior hint throws, forcing every caller to choose.
  streamingBehaviors: ["steer", "followUp"],
});
