import type { AgentRuntime, ForkNativePayload } from "../runtime/types.js";
import {
  normalizeMessages,
  buildSeedPrompt,
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
 *     ("full") or must seed a continuation prompt ("seeded"), and produce the
 *     concrete instruction the server uses to stand the new session up.
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
 * Decide the fidelity a fork of `bundle` into `targetRuntime` can achieve —
 * "full" only when the target is the SAME runtime that produced the native
 * payload and can import it; "seeded" otherwise. Pure; no side effects.
 */
export function resolveForkFidelity(bundle: ForkBundle, targetRuntime: AgentRuntime): ForkFidelity {
  const native = bundle.native;
  const canImport =
    !!native &&
    native.runtimeId === targetRuntime.id &&
    !!targetRuntime.capabilities.forkTransport &&
    typeof targetRuntime.importForFork === "function";
  return canImport ? "full" : "seeded";
}

/** Resume an imported native transcript (full fidelity). */
export interface ForkResume {
  kind: "resume";
  fidelity: "full";
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
 * either resume a natively imported transcript (full) or a seed prompt for a
 * fresh session (seeded). The server executes the returned plan (worktree +
 * session creation live there); this stays pure of daemon wiring.
 */
export async function materializeFork(opts: MaterializeForkOptions): Promise<ForkPlan> {
  const { bundle, targetRuntime, ctx } = opts;
  if (resolveForkFidelity(bundle, targetRuntime) === "full" && bundle.native && targetRuntime.importForFork) {
    const { sessionFile, id } = await targetRuntime.importForFork(bundle.native, ctx);
    return { kind: "resume", fidelity: "full", sessionFile, id };
  }
  const seedPrompt = buildSeedPrompt(bundle.normalized, {
    targetAgent: targetRuntime.displayName,
    context: { repoSlug: bundle.record.repoSlug, branch: bundle.record.branch, prUrl: bundle.record.prUrl },
    ...opts.seed,
  });
  return { kind: "seed", fidelity: "seeded", seedPrompt };
}
