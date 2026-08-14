// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { defineAgentIntegration, type AgentIntegrationOrigin } from "../definition.js";
import type { AgentInfo, AgentInstallCommand, AgentSessionOptions } from "../types.js";
import { withExactCapabilitySurface, type AgentRuntime, type RuntimeCapabilities } from "../../runtime/types.js";
import { PiRuntime } from "./runtime.js";

export const PI_TESTED_VERSION = "0.84.1";

const PI_CAPABILITIES: RuntimeCapabilities = withExactCapabilitySurface({
  toolInterception: true,
  modelSelection: true,
  packages: true,
  resume: true,
  fork: false,
  interactiveTui: true,
  usageReporting: true,
  sessionDiscovery: true,
  streamingBehaviors: ["steer", "followUp"],
});

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export function piCommand(): string {
  return process.env.BIVY_PI_COMMAND?.trim() || "pi";
}

const PI_COMMAND_CACHE = new Map<string, boolean>();

export function piCommandAvailable(): boolean {
  const command = piCommand();
  const cached = PI_COMMAND_CACHE.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  const available = result.status === 0;
  PI_COMMAND_CACHE.set(command, available);
  return available;
}

export function invalidatePiCommandProbe(): void {
  PI_COMMAND_CACHE.clear();
}

export function piIntegration(origin: AgentIntegrationOrigin) {
  return defineAgentIntegration<AgentInfo, AgentSessionOptions, AgentRuntime, AgentInstallCommand>({
    id: "pi",
    visible: true,
    origin,
    describe: () => {
      const installed = piCommandAvailable();
      return {
        id: "pi",
        executionMode: "protocol",
        displayName: "Pi",
        description: "The operator-installed Pi coding agent connected to Bivy for durable sessions, governance, packages, and model selection.",
        status: installed ? "available" : "external",
        packageName: "@earendil-works/pi-coding-agent",
        language: "TypeScript",
        capabilities: PI_CAPABILITIES,
        supportTier: "supported",
        testedVersion: PI_TESTED_VERSION,
        source: origin,
        authOwner: "agent",
        notes: installed
          ? "Uses the Pi command and agent-owned auth/configuration already on this node, and hands sessions back to that native TUI."
          : "Install and sign in to Pi on this node; Bivy will connect to that existing agent.",
        install: installed ? undefined : {
          label: "Install Pi",
          description: "Installs the upstream Pi coding agent on this node.",
          command: "npm install --global @earendil-works/pi-coding-agent",
        },
      };
    },
    create: (options) => {
      if (!piCommandAvailable()) throw new Error(`Pi command not found on PATH: ${piCommand()}`);
      // Vault-backed credentials (see catalogRuntimes): the daemon-hosted Pi
      // session reads the shared vault the user signed in to, not Pi's own
      // plaintext auth.json. The agent dir still supplies config/models/packages.
      return new PiRuntime({ ...options, piDir: piAgentDir(), credentialOwner: "bivy" });
    },
    install: (prefix) => ({
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, "@earendil-works/pi-coding-agent"],
      display: `npm install --global --prefix ${prefix} @earendil-works/pi-coding-agent`,
    }),
  });
}
