// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The live-session record — the in-memory shape the daemon tracks per open
// session. Moved out of server.ts as the first step of the SessionEngine
// decomposition. Kept deliberately as a plain
// mutable data shape (Option 1) — the engine that will own the live-session Map
// imports this type; fields are still read/written in place by server.ts today.
import type { RuntimeSession, UsageSnapshot } from "../runtime/index.js";
import type { SandboxTier } from "../harness/sandbox.js";
import type { ApprovalMode } from "../guard.js";
import type { Worktree } from "../worktree.js";
import type { BivySessionSource } from "./bivy-session.js";
import type { PrRef } from "../metadata.js";
import type { SessionWorkspaceState } from "./session-state.js";
import type { SessionRerouteController } from "../policy/session-reroute.js";
import type { StallTrigger } from "./turn-watchdog.js";

/** How a follow-up prompt relates to the in-flight turn. */
export type StreamingBehavior = "steer" | "followUp";

/**
 * Resolve the streamingBehavior for a prompt when the client didn't request one.
 * A prompt sent while a turn is genuinely in flight defaults to *steering* it
 * (inject guidance into the running turn); otherwise it starts a fresh turn.
 *
 * "In flight" is judged from BOTH Bivy's own authoritative turn flag (`isWorking`,
 * set on the first turn event and cleared on `agent_end`) AND the runtime's
 * `isStreaming` — never `isStreaming` alone. `isStreaming` is the SDK/runtime's
 * bit and can be stuck-true after a turn has actually ended. When it is,
 * defaulting to "steer" injects the user's message into a turn that no longer
 * exists, so it silently vanishes and the session looks wedged. Requiring both
 * flags means a message to an already-ended turn starts a fresh turn instead.
 */
export function resolveStreamingBehavior(
  requested: StreamingBehavior | undefined,
  turn: { isWorking?: boolean; isStreaming: boolean },
): StreamingBehavior | undefined {
  if (requested) return requested;
  return turn.isWorking && turn.isStreaming ? "steer" : undefined;
}

/** A stalled/wedged turn the watchdog flagged for the user to Stop or keep going,
 *  instead of force-killing it. Set by flagTurnForReview; cleared when the user
 *  resolves it, the turn resumes progress, or it ends/recovers (turn-watchdog-runtime). */
export interface TurnAttention {
  trigger: StallTrigger;
  idleMs: number;
  at: number;
}

/** An inline image attachment carried with a prompt. */
export type PromptImage = { type: "image"; data: string; mimeType: string };

/** Per-prompt options resolved for a turn (the shape `promptOptionsFor` returns). */
export interface PromptOptions {
  streamingBehavior?: StreamingBehavior;
  images?: PromptImage[];
}

export type SessionRecord = { id: string; session: RuntimeSession; runtimeId: string; sandbox?: SandboxTier; approvalMode?: ApprovalMode; workspace: string; sessionFile?: string; agentServiceAddress?: string; lastActivity?: unknown; lastTouchedAt?: number; isWorking?: boolean; workingStartedAt?: number; lastProgressAt?: number; lastStructuralProgressAt?: number; lastFailureAt?: number; turnWatchdog?: NodeJS.Timeout; turnTimeoutSignal?: Promise<void>; turnTimeoutResolve?: () => void; turnTimedOut?: boolean; turnAttention?: TurnAttention; abortRecovery?: Promise<void>; authRequiredSignaled?: boolean; naming?: boolean; namedFromFirstPrompt?: boolean; namingAttempts?: number; firstNamingPrompt?: string; worktree?: Worktree; source?: BivySessionSource; forkedFrom?: string; branchPushed?: boolean; branchPushing?: boolean; prUrl?: string; prs?: PrRef[]; prDetecting?: boolean; tuiTermId?: string; tuiRefreshing?: boolean; remoteActive?: boolean; ephemeral?: boolean; unsubscribe?: () => void; paused?: boolean; warning?: string; costUsd?: number; usage?: UsageSnapshot; githubIssueUrl?: string; mcpRestore?: () => void; harnessTurnReady?: Promise<void>; workspaceState?: SessionWorkspaceState; lastPrompt?: string; lastPromptOptions?: PromptOptions; reroute?: SessionRerouteController; seenAttachmentHashes?: Set<string> };
