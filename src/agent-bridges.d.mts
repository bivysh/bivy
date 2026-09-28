// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
export interface AgentBridge {
  command: string;
  packages: string[];
}

export declare const AGENT_BRIDGES: Record<string, AgentBridge>;

export interface ResolvedBridge {
  dir: string;
  version: string;
  source: "bivy" | "bridges";
}

export declare function bridgeVersions(): Record<string, string>;
export declare function bridgesDir(env?: Record<string, string | undefined>): string;
export declare function resolveBridge(name: string, dir?: string): ResolvedBridge | undefined;
export declare function bridgeInstalled(name: string, dir?: string): boolean;
export declare function missingBridges(agentId: string, dir?: string): string[];
export declare function bridgesToSync(options?: { dir?: string; commandExists?: (command: string) => boolean }): string[];
export declare function installBridges(
  names: string[],
  options?: { dir?: string; stdio?: "inherit" | "pipe" },
): Promise<{ installed: string[]; output: string }>;
export declare function enableBridgeResolution(dir?: string): void;
