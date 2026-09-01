// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { defineAgentIntegration, type AgentIntegrationOrigin } from "../definition.js";
import type { AgentInfo, AgentInstallCommand, AgentSessionOptions } from "../types.js";
import type { AgentRuntime, OpenSessionOptions, OpenSessionResult, SessionSummary, ForkNativePayload, ForkImportContext, ForkHistoryMessage, DiscoveredNativeSession, CatalogProvider } from "../../runtime/types.js";
import { PI_CAPABILITIES } from "./capabilities.js";

export const PI_TESTED_VERSION = "0.84.4";

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export function piCommand(): string {
  return process.env.BIVY_PI_COMMAND?.trim() || "pi";
}

/** List sessions written by the operator's native `pi` TUI. Governed Pi chats
 * use Bivy's own sessions directory, while `bivy run pi` intentionally keeps
 * Pi's native auth/config untouched and therefore writes under
 * PI_CODING_AGENT_DIR (normally ~/.pi/agent). Takeover discovery must inspect
 * that native store rather than only the governed one. */
export async function listNativePiSessions(): Promise<SessionSummary[]> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  // Do not pass the sessions root here. Pi's default store is split into one
  // encoded subdirectory per cwd, and SessionManager.listAll(customDir) scans
  // only that directory itself. The no-argument form walks those cwd
  // subdirectories under PI_CODING_AGENT_DIR; passing `<agentDir>/sessions`
  // therefore made every normal native TUI session invisible to takeover.
  const sessions = await SessionManager.listAll();
  return sessions.map((session) => ({
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
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

export function piBridgeInstalled(): boolean {
  try {
    import.meta.resolve("@earendil-works/pi-coding-agent");
    return true;
  } catch {
    return false;
  }
}

type PiRuntimeOptions = AgentSessionOptions & { piDir: string; credentialOwner: "agent" | "bivy" };

function unsupportedNodeMessage(): string {
  return `Pi requires Node.js 22.19+ (found ${process.version}). Upgrade Node, or select another agent such as Claude Code/Codex/OpenCode.`;
}

function nodeSupportsPi(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export class LazyPiRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly capabilities = PI_CAPABILITIES;
  private inner?: Promise<AgentRuntime>;

  constructor(private readonly options: PiRuntimeOptions) {}

  private async runtime(): Promise<AgentRuntime> {
    if (!nodeSupportsPi()) throw new Error(unsupportedNodeMessage());
    this.inner ??= import("./runtime.js").then(({ PiRuntime }) => new PiRuntime(this.options));
    return this.inner;
  }

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> { return (await this.runtime()).createSession(options); }
  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> { return (await this.runtime()).openSession(options); }
  async listSessions(): Promise<SessionSummary[]> { return (await this.runtime()).listSessions(); }
  async importForFork(payload: ForkNativePayload, ctx: ForkImportContext): Promise<{ sessionFile: string; id: string }> {
    const rt = await this.runtime();
    if (!rt.importForFork) throw new Error("Pi fork import is unavailable");
    return rt.importForFork(payload, ctx);
  }
  async importHistoryForFork(history: ForkHistoryMessage[], ctx: ForkImportContext): Promise<{ sessionFile: string; id: string }> {
    const rt = await this.runtime();
    if (!rt.importHistoryForFork) throw new Error("Pi fork history import is unavailable");
    return rt.importHistoryForFork(history, ctx);
  }
  async deleteSession(sessionId: string, sessionFile?: string): Promise<boolean> { return (await this.runtime()).deleteSession?.(sessionId, sessionFile) ?? false; }
  async discoverNativeSessions(): Promise<DiscoveredNativeSession[]> { return (await this.runtime()).discoverNativeSessions?.() ?? []; }
  async listCatalog(): Promise<CatalogProvider[]> { return (await this.runtime()).listCatalog?.() ?? []; }
}

export function piIntegration(origin: AgentIntegrationOrigin) {
  return defineAgentIntegration<AgentInfo, AgentSessionOptions, AgentRuntime, AgentInstallCommand>({
    id: "pi",
    visible: true,
    origin,
    describe: () => {
      const commandInstalled = piCommandAvailable();
      const bridgeInstalled = piBridgeInstalled();
      const installed = commandInstalled && bridgeInstalled && nodeSupportsPi();
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
        notes: !nodeSupportsPi()
          ? unsupportedNodeMessage()
          : installed
            ? "Uses the Pi command and agent-owned auth/configuration already on this node, and hands sessions back to that native TUI."
            : commandInstalled
              ? "Pi is on PATH, but Bivy's optional Pi bridge is not installed. Select Pi in setup or run 'bivy agents:install'."
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
      if (!piBridgeInstalled()) throw new Error("Bivy's optional Pi bridge is not installed. Run 'bivy setup' and choose Pi, or run 'bivy agents:install'.");
      // Vault-backed credentials (see catalogRuntimes): the daemon-hosted Pi
      // session reads the shared vault the user signed in to, not Pi's own
      // plaintext auth.json. The agent dir still supplies config/models/packages.
      return new LazyPiRuntime({ ...options, piDir: piAgentDir(), credentialOwner: "bivy" });
    },
    install: (prefix) => ({
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, "@earendil-works/pi-coding-agent"],
      display: `npm install --global --prefix ${prefix} @earendil-works/pi-coding-agent`,
    }),
  });
}
