import type { AgentRuntime, ForkImportContext, ForkNativePayload, RuntimeMessage } from "../runtime/types.js";
import {
  normalizeMessages,
  buildSeedPrompt,
  buildForkHistory,
  type ForkFidelity,
  type NormalizedTranscript,
  type SeedPromptOptions,
} from "./transcript-normal.js";

/**
 * Session **fork** engine.
 *
 * A fork continues an existing session in a new one, independently choosing the
 * node, agent, and/or model. This module is the runtime-agnostic core, split
 * across the two nodes a fork can span:
 *
 *   - `buildForkBundle` runs on the SOURCE node: it captures a portable
 *     `ForkBundle` (normalized transcript + an optional same-runtime native
 *     payload + the portable session metadata).
 *   - `resolveForkFidelity` / `materializeFork` run on the DESTINATION node:
 *     they decide whether the target runtime can replay the native payload
 *     ("full"), materialise the portable transcript as real history in its own
 *     store ("replayed" — a true fork across agents), or must seed a
 *     continuation prompt ("seeded"), and produce the concrete instruction the
 *     server uses to stand the new session up.
 *
 * Transport of the bundle between nodes is client-mediated (the PWA holds both
 * room keys) and lives in the server/controller layers; this module is pure of
 * transport and daemon state so it is unit-testable with fake runtimes.
 */

/** The portable slice of a session's metadata a fork needs to reconstruct it. */
export interface ForkRecord {
  sourceSessionId: string;
  sourceNodeId?: string;
  runtimeId: string;
  workspace: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  repoSlug?: string;
  issueNumber?: number;
  issueUrl?: string;
  prUrl?: string;
  source?: string;
  title?: string;
  model?: string;
  /** Provider/id pair for preserving the model on a same-runtime fork. */
  modelRef?: { provider: string; id: string };
  /**
   * The source session's sandbox tier (a `SandboxTier` string). Carried so a
   * fork of a sandboxed session lands sandboxed too, rather than silently
   * defaulting to the destination node's tier. Typed loosely to keep this
   * runtime-agnostic module free of the harness dependency; the server
   * normalizes it back to a `SandboxTier` before use.
   */
  sandbox?: string;
}

/** Uncommitted working-tree changes carried alongside the transcript. */
export interface ForkDirtyPatch {
  /** `git diff` (tracked changes) as a unified patch, empty when clean. */
  patch: string;
  /** Relative paths of untracked files included in `patch` via --intent-to-add. */
  untracked: string[];
  /**
   * The snapshot exceeded the transport limit and was NOT captured. Importers
   * must reject this bundle rather than silently creating a fork without WIP.
   * `pushedInstead` is retained as the wire-compatible marker used by older
   * nodes; despite its historical name, uncommitted files cannot be preserved
   * by pushing the branch alone.
   */
  pushedInstead?: boolean;
  /** Actual and configured snapshot sizes, for an actionable error. */
  byteLength?: number;
  maxBytes?: number;
}

/**
 * In-flight state the source had when the bundle was captured. A pending tool
 * approval and a mid-turn ("working") session belong to the SOURCE runtime's
 * live turn and cannot be replayed into a fork/move — so they are carried here
 * purely to DISCLOSE them on the destination (a notice), never silently dropped.
 */
export interface ForkInFlightState {
  /** The source session was mid-turn when captured. */
  working?: boolean;
  /** Unanswered tool approvals (bounded metadata: tool name + request id). */
  pendingApprovals?: Array<{ toolName?: string; requestId?: string }>;
}

/** The full, E2E-transported fork payload. */
export interface ForkBundle {
  record: ForkRecord;
  normalized: NormalizedTranscript;
  /** Present only when the source runtime supports same-runtime full transport. */
  native?: ForkNativePayload;
  dirtyPatch?: ForkDirtyPatch;
  /** In-flight turn/approval state, carried for disclosure (see the interface). */
  state?: ForkInFlightState;
}

export interface BuildForkBundleOptions {
  runtime: AgentRuntime;
  /** Runtime resume ref when one exists. Non-resumable/live-only agents omit it. */
  sessionFile?: string;
  record: ForkRecord;
  dirtyPatch?: ForkDirtyPatch;
  /**
   * The runtime the fork is known to target, when the client has already chosen
   * a different agent. A native payload is only ever replayable by the SAME
   * runtime that produced it (see `resolveForkFidelity`), so when the target is
   * a *different* known runtime we skip capturing it — it could never be used
   * and would only bloat the bundle. Omit (or pass the source runtime's id) to
   * keep the native payload for a potential full-fidelity replay.
   */
  targetRuntimeId?: string;
  /**
   * The source session's LIVE transcript, used as the normalized-transcript
   * source when the runtime has no `readMessages` fast path. The generic CLI
   * runtime (which backs most wrapped agents) builds its transcript from parsed
   * stdout and keeps it only on the live session — without this a fork *from*
   * one of those agents would carry an empty transcript, degrading even the
   * seeded prompt to "(no prior turns)". `readMessages` is still preferred when
   * present (pi/Claude), so this only fills the gap. Same `{role, content}`
   * shape as `readMessages`. Omit when the runtime already exposes readMessages.
   */
  liveMessages?: readonly RuntimeMessage[];
  /** In-flight turn/approval state to carry for disclosure on the destination. */
  state?: ForkInFlightState;
}

/**
 * Capture a fork bundle on the source node. Always includes the normalized
 * transcript (the cross-runtime seed, and the fallback when a same-runtime
 * destination can't natively import). Adds the runtime's native payload for a
 * full same-runtime replay — but only when the fork could actually use it: a
 * fork to a known different agent skips it, since the native format never
 * round-trips across runtimes.
 */
export function buildForkBundle(opts: BuildForkBundleOptions): ForkBundle {
  const { runtime, sessionFile, record } = opts;
  // The live session is authoritative: a persisted native reader can lag the
  // current turn (or return an empty-but-valid snapshot during a flush race).
  // Prefer liveMessages whenever the caller has them, and use readMessages only
  // when no live transcript was supplied. This avoids silently truncating a fork
  // made while the source is open, while still supporting offline/native refs.
  let messages = opts.liveMessages;
  if (messages === undefined && sessionFile && runtime.readMessages) {
    try {
      messages = runtime.readMessages(sessionFile);
    } catch {
      // Runtime-native readers are best-effort. An unavailable reader yields an
      // empty portable transcript, which still degrades safely to a seed.
    }
  }
  const normalized = normalizeMessages(messages, {
    sourceRuntimeId: runtime.id,
    model: record.model,
    title: record.title,
    createdAt: new Date().toISOString(),
  });
  // Only worth capturing when the target is the same runtime (or not yet known).
  const nativeCouldReplay = !opts.targetRuntimeId || opts.targetRuntimeId === runtime.id;
  let native: ForkNativePayload | undefined;
  if (sessionFile && nativeCouldReplay && runtime.capabilities.forkTransport && runtime.exportForFork) {
    try {
      native = runtime.exportForFork(sessionFile);
    } catch {
      // A native export is an optimization, never the only route. The portable
      // transcript below still supports replay or a seeded continuation.
    }
  }
  return { record, normalized, ...(native ? { native } : {}), ...(opts.dirtyPatch ? { dirtyPatch: opts.dirtyPatch } : {}), ...(opts.state ? { state: opts.state } : {}) };
}

/**
 * Decide the best fidelity a fork of `bundle` into `targetRuntime` can achieve:
 *   - "full"     when the target is the SAME runtime that produced the native
 *                payload and can import it (byte-exact resume);
 *   - "replayed" when a *different* target can import portable history
 *                (`forkHistoryImport`) and there is history to replay — a true
 *                fork onto a copy of the transcript;
 *   - "seeded"   otherwise.
 * Pure; no side effects. `materializeFork` degrades "replayed"→"seeded" if the
 * import fails at run time, so this only reports the *intended* fidelity.
 */
export function resolveForkFidelity(bundle: ForkBundle, targetRuntime: AgentRuntime): ForkFidelity {
  const native = bundle.native;
  const canImportNative =
    !!native &&
    native.runtimeId === targetRuntime.id &&
    !!targetRuntime.capabilities.forkTransport &&
    typeof targetRuntime.importForFork === "function";
  if (canImportNative) return "full";
  const canReplayHistory =
    !!targetRuntime.capabilities.forkHistoryImport &&
    typeof targetRuntime.importHistoryForFork === "function" &&
    Array.isArray(bundle.normalized?.turns) &&
    bundle.normalized.turns.length > 0;
  return canReplayHistory ? "replayed" : "seeded";
}

/**
 * Resume a materialised transcript on this node — either a byte-exact native
 * import ("full") or the portable history replayed into the target's own store
 * ("replayed"). Both yield a real session the server resumes by `sessionFile`.
 */
export interface ForkResume {
  kind: "resume";
  fidelity: "full" | "replayed";
  /** Resume ref for the freshly materialised session on this node. */
  sessionFile: string;
  id: string;
}

/** Create a new session seeded with a continuation prompt (cross-runtime). */
export interface ForkSeed {
  kind: "seed";
  fidelity: "seeded";
  /** The first prompt to send into a brand-new session on the target runtime. */
  seedPrompt: string;
}

export type ForkPlan = ForkResume | ForkSeed;

export interface MaterializeForkOptions {
  bundle: ForkBundle;
  targetRuntime: AgentRuntime;
  ctx: ForkImportContext;
  /** Seed prompt shaping for the cross-runtime path (transcript URL, target name…). */
  seed?: SeedPromptOptions;
}

/**
 * Turn a fork bundle into a concrete stand-up plan on the destination node:
 * resume a natively imported transcript (full), replay the portable transcript
 * as real history in the target's own store (replayed — a true cross-runtime
 * fork), or a seed prompt for a fresh session (seeded). The server executes the
 * returned plan (worktree + session creation live there); this stays pure of
 * daemon wiring.
 */
export async function materializeFork(opts: MaterializeForkOptions): Promise<ForkPlan> {
  const { bundle, targetRuntime, ctx } = opts;
  const intended = resolveForkFidelity(bundle, targetRuntime);
  const validImport = (result: { sessionFile?: unknown; id?: unknown } | undefined): result is { sessionFile: string; id: string } =>
    typeof result?.sessionFile === "string" && result.sessionFile.trim().length > 0 &&
    typeof result.id === "string" && result.id.trim().length > 0;

  // Native transport is the preferred same-runtime route, but never a single
  // point of failure. An adapter upgrade, stale native store, or malformed
  // payload degrades through the exact same portable path all agents share.
  if (intended === "full" && bundle.native && targetRuntime.importForFork) {
    try {
      const imported = await targetRuntime.importForFork(bundle.native, ctx);
      if (validImport(imported)) return { kind: "resume", fidelity: "full", ...imported };
    } catch {
      // Continue to portable replay (if supported), then the universal seed.
    }
  }

  // Write the runtime-neutral conversation into any destination that advertises
  // a native history serializer. This path also rescues a failed same-runtime
  // native import, so Pi/Claude/Codex all share one degradation ladder.
  const canReplay =
    !!targetRuntime.capabilities.forkHistoryImport &&
    typeof targetRuntime.importHistoryForFork === "function";
  if (canReplay) {
    try {
      const history = buildForkHistory(bundle.normalized);
      if (history.length > 0) {
        const imported = await targetRuntime.importHistoryForFork!(history, ctx);
        if (validImport(imported)) return { kind: "resume", fidelity: "replayed", ...imported };
      }
    } catch {
      // Fall through to the agent-independent seeded continuation below.
    }
  }

  const seedPrompt = buildSeedPrompt(bundle.normalized, {
    targetAgent: targetRuntime.displayName,
    context: { repoSlug: bundle.record.repoSlug, branch: bundle.record.branch, prUrl: bundle.record.prUrl },
    ...opts.seed,
  });
  return { kind: "seed", fidelity: "seeded", seedPrompt };
}
