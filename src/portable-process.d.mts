// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { spawn, spawnSync } from "node:child_process";

export declare function resolveExecutable(
  command: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
  platform?: NodeJS.Platform,
): string | null;

export interface PortableCommand {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
}

export declare function portableCommand(
  command: string,
  args?: readonly string[],
  context?: { env?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform },
): PortableCommand;

export declare const portableSpawn: typeof spawn;
export declare const portableSpawnSync: typeof spawnSync;

export declare function killProcessTree(pid: number | undefined, signal?: NodeJS.Signals, platform?: NodeJS.Platform): boolean;

export declare function npmPrefixBin(prefix: string, platform?: NodeJS.Platform): string;
