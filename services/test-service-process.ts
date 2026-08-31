// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

/**
 * Start a TypeScript service without the `npx -> tsx -> node` wrapper chain.
 *
 * Tests must retain the returned process and pass it to stopTestServices().
 * Spawning Node directly ensures SIGTERM reaches the service rather than only
 * terminating a wrapper and orphaning the real server.
 */
export function spawnTestService(cwd: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

async function stopTestService(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  if (await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))])) return;

  child.kill("SIGKILL");
  await exited;
}

/** Gracefully stop test services, with a bounded hard-kill fallback. */
export async function stopTestServices(children: Iterable<ChildProcess>, timeoutMs = 5_000): Promise<void> {
  await Promise.all(Array.from(children, (child) => stopTestService(child, timeoutMs)));
}
