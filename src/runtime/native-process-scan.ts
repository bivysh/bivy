// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Best-effort "is there a live process for this discovered session" check (see
// issue #156's "detect live external processes and offer follow/read-only or
// safe takeover"). Bivy has no attach/IPC channel into a bare `claude`/`codex`
// a user launched outside it, so this can only ever be a heuristic: match a
// running process whose command name is one of the provider's binaries AND
// whose current working directory equals the discovered session's cwd. A false
// negative (missed live process) just means adoption proceeds as if idle; a
// false positive only costs an extra confirmation. Never used for anything
// security-sensitive — display/gating only.
//
// The process listing is injectable so callers (and tests) never depend on the
// real OS: `hasLiveProcessForCwd`'s default lister shells out to `ps`, which is
// unavailable/unreliable on some platforms and always best-effort (wrapped in
// try/catch, empty on any failure).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface OsProcessInfo {
  pid: number;
  /** The process's own binary/command name (basename, not the full argv line). */
  command: string;
  /** Current working directory, when it could be determined. */
  cwd?: string;
}

/**
 * List processes currently running on this node. Linux: reads `/proc` for an
 * exact cwd via `/proc/<pid>/cwd`. Other platforms: falls back to `ps -axo
 * pid=,comm=` with no cwd (so cwd-based matching below always reports "not
 * live" there rather than guessing). Never throws; returns [] on any failure.
 */
export function listOsProcesses(): OsProcessInfo[] {
  try {
    if (process.platform === "linux") return listLinuxProcesses();
    return listProcessesViaPs();
  } catch {
    return [];
  }
}

function listLinuxProcesses(): OsProcessInfo[] {
  const out: OsProcessInfo[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let comm: string;
    try {
      comm = fs.readFileSync(`/proc/${entry}/comm`, "utf8").trim();
    } catch {
      continue; // process exited mid-scan, or unreadable — skip it
    }
    let cwd: string | undefined;
    try {
      cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      cwd = undefined; // permission denied (another user's process) — command-only match
    }
    out.push({ pid, command: comm, cwd });
  }
  return out;
}

/** macOS/other POSIX fallback: `ps` reports the command name only, no cwd. */
function listProcessesViaPs(): OsProcessInfo[] {
  const result = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  const out: OsProcessInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const command = match[2]!.split(/[\\/]/).pop() ?? match[2]!;
    out.push({ pid: Number(match[1]), command });
  }
  return out;
}

/**
 * Best-effort: is one of `binNames` currently running with cwd === `cwd`?
 * Returns false (never throws) when the cwd can't be determined for any
 * candidate process on this platform — an unproven match is treated as "not
 * live" rather than risking a false "active" that would block adoption.
 */
export function hasLiveProcessForCwd(
  cwd: string,
  binNames: string[],
  lister: () => OsProcessInfo[] = listOsProcesses,
): boolean {
  if (!cwd) return false;
  const target = path.resolve(cwd);
  const names = new Set(binNames.map((n) => n.toLowerCase()));
  try {
    return lister().some((p) => p.cwd != null && names.has(p.command.toLowerCase()) && path.resolve(p.cwd) === target);
  } catch {
    return false;
  }
}
