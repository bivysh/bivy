// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";
import type { SessionSummary } from "./types.js";

/** Pi creates its own session id after the native TUI starts, so `bivy run pi`
 * cannot pin one on the terminal metadata the way Claude can. Correlate the PTY
 * with Pi's durable session index by workspace and creation time instead. */
export function discoverPiSessionForCwd(
  sessions: SessionSummary[],
  cwd: string,
  since: number,
): SessionSummary | undefined {
  const wanted = normalizePath(cwd);
  if (!wanted || !Number.isFinite(since)) return undefined;

  // The PTY process is spawned just before TerminalManager stamps createdAt. On
  // a fast machine Pi can write its session header a few milliseconds earlier,
  // so allow a small clock/scheduling margin rather than requiring >= exactly.
  const earliest = since - 10_000;
  return sessions
    .filter((session) => normalizePath(session.cwd || "") === wanted)
    .map((session) => ({ session, createdAt: timestamp(session.created) }))
    .filter(({ createdAt }) => createdAt >= earliest)
    .sort((a, b) => {
      const distance = Math.abs(a.createdAt - since) - Math.abs(b.createdAt - since);
      if (distance !== 0) return distance;
      return timestamp(b.session.modified) - timestamp(a.session.modified);
    })[0]?.session;
}

function normalizePath(value: string): string {
  if (!value) return "";
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
