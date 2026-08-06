// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// System-resource snapshot for the node the current session runs on.
//
// Surfaced to the web app's "Node stats" panel (header ⋯ menu). For each of
// memory, CPU, and storage it reports three tiers:
//
//   * session — the active session's live agent subprocess tree. Agents spawn
//     per-turn and exit, so this is non-zero only while a turn is running (and
//     only for runtimes with a separable OS process — Pi runs in-process, and
//     Claude Code's process lives inside its SDK). `measurable` says whether a
//     figure could be attributed at all.
//   * bivy — the whole Bivy node process tree (server + every live agent child +
//     PTYs). Uniform across runtimes; this is "everything Bivy is using".
//   * node — the machine total (what's available), so the other two can be shown
//     as both an absolute figure and a percentage of the whole node.

import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0;

// ---------------------------------------------------------------------------
// Process table (portable via `ps`; empty on platforms without it, e.g. Windows)
// ---------------------------------------------------------------------------

interface ProcEntry {
  pid: number;
  ppid: number;
  rssBytes: number;
  /** %CPU as `ps` reports it: share of a single core (can exceed 100 on a
   *  multithreaded process). Recent-average, not strictly instantaneous. */
  pcpu: number;
}

async function psSnapshot(): Promise<Map<number, ProcEntry>> {
  const table = new Map<number, ProcEntry>();
  try {
    const { stdout } = await execFileP("ps", ["-Ao", "pid=,ppid=,rss=,pcpu="], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 4000,
    });
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const rssKb = Number(parts[2]);
      const pcpu = Number(parts[3]);
      if (!Number.isFinite(pid)) continue;
      table.set(pid, { pid, ppid, rssBytes: (Number.isFinite(rssKb) ? rssKb : 0) * 1024, pcpu: Number.isFinite(pcpu) ? pcpu : 0 });
    }
  } catch {
    // ps missing/blocked — subtree sums degrade to empty (tiers report null).
  }
  return table;
}

/** All entries in the subtree rooted at `rootPid` (inclusive), by ppid links. */
function subtree(table: Map<number, ProcEntry>, rootPid: number): ProcEntry[] {
  const kids = new Map<number, number[]>();
  for (const p of table.values()) {
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  const out: ProcEntry[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = table.get(pid);
    if (entry) out.push(entry);
    for (const child of kids.get(pid) ?? []) stack.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CPU sampling
// ---------------------------------------------------------------------------

function sumCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Sample node-wide busy% and this process's own busy% over one window. The
 *  main process's CPU is measured accurately via process.cpuUsage() (the `ps`
 *  lifetime-average would badly under-report a long-lived server), while agent
 *  children are attributed from the `ps` snapshot. */
async function sampleCpu(cores: number, ms = 150): Promise<{ nodePct: number; mainNodePct: number }> {
  const startCpus = sumCpuTimes();
  const startProc = process.cpuUsage();
  const startAt = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  const endCpus = sumCpuTimes();
  const endProc = process.cpuUsage(startProc);
  const elapsedMs = Math.max(1, Date.now() - startAt);

  const idleDelta = endCpus.idle - startCpus.idle;
  const totalDelta = endCpus.total - startCpus.total;
  const nodePct = totalDelta > 0 ? Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)) : 0;

  // process.cpuUsage() is microseconds of user+system across all cores this
  // process used in the window. Convert to a share of one core, then of the node.
  const procMicros = endProc.user + endProc.system;
  const mainCorePct = (procMicros / 1000 / elapsedMs) * 100;
  const mainNodePct = cores > 0 ? Math.min(100, mainCorePct / cores) : 0;

  return { nodePct, mainNodePct };
}

// ---------------------------------------------------------------------------
// Storage: statfs for the filesystem, cached `du` for directory footprints
// ---------------------------------------------------------------------------

interface DuCacheEntry {
  bytes: number | null;
  at: number;
  inflight?: Promise<void>;
}
const duCache = new Map<string, DuCacheEntry>();

async function measureDir(pathStr: string): Promise<number | null> {
  try {
    // -s summary, -k KiB, -x stay on one filesystem (don't wander into mounts).
    const { stdout } = await execFileP("du", ["-skx", pathStr], { timeout: 8000, maxBuffer: 1024 * 1024 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Directory size in bytes, cached for `ttlMs`. `du` can be slow on big trees,
 *  so a stale value is returned immediately while a refresh runs in the
 *  background; only the very first call for a path awaits (bounded by du's own
 *  timeout) so the panel isn't blank on open. */
async function dirSizeCached(pathStr: string, ttlMs = 20000): Promise<number | null> {
  const now = Date.now();
  const cached = duCache.get(pathStr);
  if (cached && now - cached.at < ttlMs) return cached.bytes;

  const entry: DuCacheEntry = cached ?? { bytes: null, at: 0 };
  duCache.set(pathStr, entry);
  if (!entry.inflight) {
    entry.inflight = (async () => {
      const bytes = await measureDir(pathStr);
      entry.bytes = bytes;
      entry.at = Date.now();
      entry.inflight = undefined;
    })();
  }
  if (!cached) {
    try {
      await entry.inflight;
    } catch {
      /* measured to null */
    }
  }
  return entry.bytes;
}

async function measureFilesystem(pathStr: string) {
  try {
    const s = await fs.statfs(pathStr);
    const bsize = Number(s.bsize) || 0;
    const total = Number(s.blocks) * bsize;
    const free = Number(s.bavail) * bsize; // available to this unprivileged user
    const used = Math.max(0, total - Number(s.bfree) * bsize);
    return { total, free, used };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

/** A per-tier figure: an absolute amount plus its share of the node total. */
interface Tier {
  bytes?: number;
  pct: number;
}

export interface NodeStats {
  nodeId?: string;
  name?: string | null;
  uptime: number;
  cores: number;
  cpuModel: string | null;
  load: [number, number, number];
  /** Whether a session-scoped figure could be attributed (a live, separable
   *  agent process was found for the requested session). */
  sessionMeasurable: boolean;
  memory: {
    node: { used: number; total: number; free: number; usedPct: number };
    bivy: Tier;
    session: Tier | null;
  };
  cpu: {
    node: { usedPct: number };
    bivy: Tier; // pct only (of the whole node)
    session: Tier | null;
  };
  storage: {
    node: { path: string; used: number; total: number; free: number; usedPct: number } | null;
    bivy: Tier | null;
    session: Tier | null;
  };
  at: string;
}

export async function collectNodeStats(opts: {
  /** Filesystem measured for the node storage figure (the default workspace). */
  workspacePath: string;
  /** Bivy's own state/data dir, measured for the "Bivy" storage footprint. */
  appDir?: string;
  /** The active session, for the session-scoped tier (optional). */
  sessionPid?: number;
  sessionWorkspace?: string;
  nodeId?: string;
  name?: string | null;
}): Promise<NodeStats> {
  const cores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model?.trim() || null;

  const [table, cpuSample, fsInfo] = await Promise.all([
    psSnapshot(),
    sampleCpu(cores),
    measureFilesystem(opts.workspacePath),
  ]);

  // --- Memory & CPU: Bivy = this process's whole subtree ---
  const bivyProcs = subtree(table, process.pid);
  let bivyRss = 0;
  let bivyChildPcpu = 0;
  for (const p of bivyProcs) {
    bivyRss += p.rssBytes;
    if (p.pid !== process.pid) bivyChildPcpu += p.pcpu;
  }
  // If ps gave us nothing (no table), fall back to this process's own RSS.
  if (bivyProcs.length === 0) bivyRss = process.memoryUsage().rss;
  const bivyCpuNodePct = Math.min(100, cpuSample.mainNodePct + (cores > 0 ? bivyChildPcpu / cores : 0));

  // --- Session tier (only when a live, separable agent process exists) ---
  let sessionMem: Tier | null = null;
  let sessionCpu: Tier | null = null;
  let sessionMeasurable = false;
  if (typeof opts.sessionPid === "number" && table.has(opts.sessionPid)) {
    const procs = subtree(table, opts.sessionPid);
    let rss = 0;
    let pcpu = 0;
    for (const p of procs) {
      rss += p.rssBytes;
      pcpu += p.pcpu;
    }
    sessionMeasurable = true;
    sessionMem = { bytes: rss, pct: pct(rss, os.totalmem()) };
    sessionCpu = { pct: Math.min(100, cores > 0 ? pcpu / cores : 0) };
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);

  // --- Storage ---
  const [bivyDir, sessionDir] = await Promise.all([
    opts.appDir ? dirSizeCached(opts.appDir) : Promise.resolve(null),
    opts.sessionWorkspace ? dirSizeCached(opts.sessionWorkspace) : Promise.resolve(null),
  ]);
  const storageTotal = fsInfo?.total ?? 0;

  return {
    nodeId: opts.nodeId,
    name: opts.name ?? null,
    uptime: os.uptime(),
    cores,
    cpuModel,
    load: (() => {
      const l = os.loadavg();
      return [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0];
    })(),
    sessionMeasurable,
    memory: {
      node: { used: usedMem, total: totalMem, free: freeMem, usedPct: pct(usedMem, totalMem) },
      bivy: { bytes: bivyRss, pct: pct(bivyRss, totalMem) },
      session: sessionMem,
    },
    cpu: {
      node: { usedPct: cpuSample.nodePct },
      bivy: { pct: bivyCpuNodePct },
      session: sessionCpu,
    },
    storage: {
      node: fsInfo ? { path: opts.workspacePath, used: fsInfo.used, total: fsInfo.total, free: fsInfo.free, usedPct: pct(fsInfo.used, fsInfo.total) } : null,
      bivy: bivyDir != null ? { bytes: bivyDir, pct: pct(bivyDir, storageTotal) } : null,
      session: sessionDir != null ? { bytes: sessionDir, pct: pct(sessionDir, storageTotal) } : null,
    },
    at: new Date().toISOString(),
  };
}
