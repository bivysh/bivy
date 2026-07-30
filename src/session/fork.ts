import type { AgentRuntime, ForkNativePayload } from "../runtime/types.js";
import {
  normalizeMessages,
  buildSeedPrompt,
  buildForkHistory,
  type ForkFidelity,
  type NormalizedTranscript,
  type SeedPromptOptions,
} from "./transcript-normal.js";

/**
 * Session **fork** engine (see docs/session-fork-plan.md).
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
}

/** Uncommitted working-tree changes carried alongside the transcript. */
export interface ForkDirtyPatch {
  /** `git diff` (tracked changes) as a unified patch, empty when clean. */
  patch: string;
  /** Relative paths of untracked files included in `patch` via --intent-to-add. */
  untracked: string[];
  /** True when the working tree was too large to inline; branch was pushed instead. */
  pushedInstead?: boolean;
}

/** The full, E2E-transported fork payload. */
export interface ForkBundle {
  record: ForkRecord;
  normalized: NormalizedTranscript;
  /** Present only when the source runtime supports same-runtime full transport. */
  native?: ForkNativePayload;
  dirtyPatch?: ForkDirtyPatch;
}

export interface BuildForkBundleOptions {
  runtime: AgentRuntime;
  /** The runtime resume ref the node holds (a path for pi, an id for Claude). */
  sessionFile: string;
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
  const messages = runtime.readMessages?.(sessionFile);
  const normalized = normalizeMessages(messages, {
    sourceRuntimeId: runtime.id,
    model: record.model,
    title: record.title,
    createdAt: new Date().toISOString(),
  });
  // Only worth capturing when the target is the same runtime (or not yet known).
  const nativeCouldReplay = !opts.targetRuntimeId || opts.targetRuntimeId === runtime.id;
  const native =
    nativeCouldReplay && runtime.capabilities.forkTransport && runtime.exportForFork
      ? runtime.exportForFork(sessionFile)
      : undefined;
  return { record, normalized, ...(native ? { native } : {}), ...(opts.dirtyPatch ? { dirtyPatch: opts.dirtyPatch } : {}) };
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
  ctx: { workspace: string; cwd: string };
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
  const fidelity = resolveForkFidelity(bundle, targetRuntime);
  if (fidelity === "full" && bundle.native && targetRuntime.importForFork) {
    const { sessionFile, id } = await targetRuntime.importForFork(bundle.native, ctx);
    return { kind: "resume", fidelity: "full", sessionFile, id };
  }
  // True cross-runtime fork: write the whole transcript as real prior turns into
  // the target runtime's own store and resume it. Best-effort — if the runtime's
  // history import throws (a malformed store, an unwritable dir), fall through to
  // a seeded prompt so the fork still succeeds rather than erroring outright.
  if (fidelity === "replayed" && targetRuntime.importHistoryForFork) {
    try {
      const history = buildForkHistory(bundle.normalized);
      if (history.length > 0) {
        const { sessionFile, id } = await targetRuntime.importHistoryForFork(history, ctx);
        return { kind: "resume", fidelity: "replayed", sessionFile, id };
      }
    } catch {
      // fall through to the seeded continuation below
    }
  }
  const seedPrompt = buildSeedPrompt(bundle.normalized, {
    targetAgent: targetRuntime.displayName,
    context: { repoSlug: bundle.record.repoSlug, branch: bundle.record.branch, prUrl: bundle.record.prUrl },
    ...opts.seed,
  });
  return { kind: "seed", fidelity: "seeded", seedPrompt };
}
