// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";

/**
 * Reduce an id-based runtime's resume ref to the bare session id it expects.
 *
 * A ref may arrive as the id itself (the common case — e.g. straight from Bivy's
 * metadata store) or, for adapters that surface an on-disk transcript path, as a
 * ".../<id>.jsonl" file (Claude Code lists sessions from ~/.claude that way). Both
 * normalize to "<id>".
 */
export function sessionIdFromRef(ref: string): string {
  return /[/\\]|\.jsonl$/i.test(ref) ? path.basename(ref).replace(/\.jsonl$/i, "") : ref;
}

/**
 * Normalize a resume ref into the token the owning runtime actually expects,
 * enforcing the sessions-dir guard only where it applies.
 *
 * Bivy is the unifying store for sessions started anywhere, so resume must work
 * for every runtime — but runtimes differ in what a "session ref" is:
 *
 *   - Path-based runtimes (pi) resume by reading a transcript file. The daemon
 *     can be handed an arbitrary path by a remote client, so these refs are
 *     confined to the node's sessions directory (path-traversal guard).
 *   - Id-based runtimes (Claude Code, …) resume by an opaque session id they
 *     validate themselves and store their transcripts elsewhere (~/.claude).
 *     There is no local file to confine, so the guard must NOT apply — doing so
 *     is what made those sessions fail with "Session file is outside the
 *     sessions directory".
 *
 * Throws for a path-based ref that escapes `sessionsDir`.
 */
export function resolveResumeRef(opts: { ref: string; resumesByPath: boolean; sessionsDir: string }): string {
  const { ref, resumesByPath, sessionsDir } = opts;
  if (!resumesByPath) return sessionIdFromRef(ref);
  const resolved = path.resolve(ref);
  if (!resolved.startsWith(path.resolve(sessionsDir) + path.sep)) {
    throw new Error("Session file is outside the sessions directory");
  }
  return resolved;
}

/**
 * Decide what to resume a client-named session from when the node isn't holding
 * it in memory (a restart, an idle close, or a session this process never
 * opened — the PWA lists sessions straight from durable metadata). Prefer an
 * explicit transcript path, then the path metadata recorded, and finally — for
 * id-based runtimes that keep no confinable local file — the session id itself.
 *
 * Returns undefined when nothing durable is known: a session this node never
 * started, or one that was deleted. The caller turns that into "Session not
 * found" rather than resurrecting a bogus session from an arbitrary id. This is
 * the decision that lets a real-but-closed session resume instead of failing —
 * the root of the PWA's "can't resume sessions / sessions not found".
 */
export function resumeRefFor(opts: { id?: string; path?: string; metaPath?: string; metaKnown: boolean }): string | undefined {
  const explicit = opts.path?.trim();
  if (explicit) return explicit;
  if (opts.metaPath) return opts.metaPath;
  if (opts.metaKnown && opts.id) return opts.id;
  return undefined;
}
