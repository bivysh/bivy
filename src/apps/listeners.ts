// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppOffer } from "./types.js";

const execFileP = promisify(execFile);

/** Loopback or wildcard TCP listeners whose process runs inside a workspace.
 * Agent-neutral by design: every framework and agent starts servers the same
 * way, so the process table is the one hook that works for all of them. A
 * listener is only an offer — access still needs a user's tap and a grant. */
export async function scanListeners(workspace: string, platform: NodeJS.Platform = process.platform): Promise<AppOffer[]> {
  let root: string;
  try { root = await fs.realpath(workspace); } catch { return []; }
  const found = platform === "linux" ? await scanProc(root) : platform === "darwin" ? await scanLsof(root) : [];
  const byPort = new Map<number, AppOffer>();
  for (const offer of found) if (offer.pid !== process.pid && offer.port >= 1024 && !byPort.has(offer.port)) byPort.set(offer.port, offer);
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

const inside = (root: string, dir: string) => dir === root || dir.startsWith(root + path.sep);

/** `local_address` in /proc/net/tcp{,6}: hex address in little-endian 32-bit words. */
export function listenPort(line: string): { inode: string; port: number } | undefined {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 10 || cols[3] !== "0A") return undefined; // 0A = LISTEN
  const [address, portHex] = cols[1].split(":");
  const words = address.match(/.{8}/g) ?? [];
  const last = words[words.length - 1] ?? "";
  const zero = /^0+$/.test(address);
  const v4Loopback = last.endsWith("7F") && (words.length === 1 || words.slice(0, 3).join("") === "0000000000000000FFFF0000");
  const v6Loopback = address === "00000000000000000000000001000000";
  if (!zero && !v4Loopback && !v6Loopback) return undefined;
  return { inode: cols[9], port: parseInt(portHex, 16) };
}

async function scanProc(root: string): Promise<AppOffer[]> {
  const sockets = new Map<string, number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const hit = listenPort(line);
      if (hit && hit.inode !== "0") sockets.set(hit.inode, hit.port);
    }
  }
  if (!sockets.size) return [];
  const offers: AppOffer[] = [];
  const pids = (await fs.readdir("/proc").catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));
  // cwd first: other users' processes fail here, and only workspace processes
  // pay for an fd walk.
  await Promise.all(pids.map(async (pid) => {
    const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => "");
    if (!cwd || !inside(root, cwd)) return;
    const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    const ports = new Set<number>();
    for (const fd of fds) {
      const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      const port = inode ? sockets.get(inode) : undefined;
      if (port) ports.add(port);
    }
    if (!ports.size) return;
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
    for (const port of ports) offers.push({ port, pid: Number(pid), command: commandLabel(argv) });
  }));
  return offers;
}

/** `lsof -F` field output: p<pid>, c<command>, n<name> records. */
export function parseLsof(stdout: string): { pid: number; values: string[] }[] {
  const records: { pid: number; values: string[] }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) records.push({ pid: Number(line.slice(1)), values: [] });
    else if (line.startsWith("n") && records.length) records[records.length - 1].values.push(line.slice(1));
  }
  return records;
}

async function scanLsof(root: string): Promise<AppOffer[]> {
  const run = (args: string[]) => execFileP("lsof", args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
  const listening = parseLsof(await run(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  if (!listening.length) return [];
  const cwds = new Map(parseLsof(await run(["-a", "-d", "cwd", "-Fpn", "-p", listening.map((r) => r.pid).join(",")])).map((r) => [r.pid, r.values[0] ?? ""]));
  const offers: AppOffer[] = [];
  for (const { pid, values } of listening) {
    const cwd = await fs.realpath(cwds.get(pid) ?? "").catch(() => "");
    if (!cwd || !inside(root, cwd)) continue;
    const args = (await execFileP("ps", ["-p", String(pid), "-o", "args="], { timeout: 4000 }).then((r) => r.stdout, () => "")).trim();
    for (const name of values) {
      const match = /^(\*|127\.[\d.]+|\[::1\]|\[::\]|localhost):(\d+)$/.exec(name);
      if (match) offers.push({ port: Number(match[2]), pid, command: commandLabel(args.split(/\s+/)) });
    }
  }
  return offers;
}

/** "node /x/node_modules/.bin/vite --port 5173" → "node vite --port 5173". */
function commandLabel(argv: string[]): string {
  const label = argv.slice(0, 4).map((arg) => arg.startsWith("/") || arg.startsWith(".") ? path.basename(arg) : arg).join(" ");
  return label.length > 60 ? `${label.slice(0, 59)}…` : label || "server";
}
