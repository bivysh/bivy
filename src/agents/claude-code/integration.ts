// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { defineAgentIntegration, type AgentIntegrationOrigin } from "../definition.js";
import type { AgentInfo, AgentInstallCommand, AgentSessionOptions } from "../types.js";
import { withExactCapabilitySurface, type AgentRuntime, type RuntimeCapabilities } from "../../runtime/types.js";
import { createCredentialStore } from "../../runtime/credentials.js";
import {
  ClaudeCodeRuntime,
  claudeRuntimeFromEnv,
  claudeSdkInstalled,
} from "./runtime.js";

export const CLAUDE_TESTED_VERSION = "0.3.232";

const CLAUDE_CAPABILITIES: RuntimeCapabilities = withExactCapabilitySurface({
  toolInterception: true,
  modelSelection: true,
  packages: false,
  resume: true,
  fork: true,
  usageReporting: true,
  nativeSessionDiscovery: true,
  nativeSessionAdoption: true,
  streamingBehaviors: ["steer"],
});

export function claudeCodeIntegration(origin: AgentIntegrationOrigin) {
  return defineAgentIntegration<AgentInfo, AgentSessionOptions, AgentRuntime, AgentInstallCommand>({
    // Compatibility id retained for existing sessions; aliases expose the agent's
    // ordinary product/command names without making SDK transport part of the UX.
    id: "claude-code-sdk",
    aliases: ["claude", "claude-code"],
    visible: true,
    origin,
    describe: () => {
      const bridgeInstalled = claudeSdkInstalled();
      const options = claudeRuntimeFromEnv();
      const agentInstalled = Boolean(options.executablePath);
      const installed = bridgeInstalled && agentInstalled;
      return {
        id: "claude-code-sdk",
        executionMode: "protocol",
        displayName: "Claude Code",
        description: "The operator-installed Claude Code agent, connected through Anthropic's SDK bridge for streaming, model selection, and governed tool calls.",
        status: installed ? "available" : "external",
        packageName: "@anthropic-ai/claude-code",
        language: "TypeScript",
        capabilities: { ...CLAUDE_CAPABILITIES, interactiveTui: agentInstalled },
        nativeSandbox: true,
        supportTier: "supported",
        testedVersion: CLAUDE_TESTED_VERSION,
        source: origin,
        authOwner: "agent",
        notes: installed
          ? "Uses the Claude Code executable already on this node, including its native auth, configuration, and sessions. Set BIVY_CLAUDE_MODEL to pick a default model."
          : agentInstalled
            ? "The Claude Code agent is installed, but this Bivy distribution is missing its SDK bridge dependency."
            : "Install and sign in to Claude Code on this node; Bivy will connect to that existing agent.",
        install: installed || agentInstalled ? undefined : {
          label: "Install Claude Code",
          description: "Installs Anthropic's Claude Code agent on this node.",
          command: "npm install --global @anthropic-ai/claude-code",
        },
      };
    },
    create: (sessionOptions) => {
      const options = claudeRuntimeFromEnv();
      if (!options.executablePath) throw new Error("Claude Code command not found on PATH: claude");
      return new ClaudeCodeRuntime({
        ...options,
        // Forward the node's shared credential vault so the Anthropic credential
        // the user already signed in with (API key or Claude Pro/Max OAuth) is
        // injected into the SDK subprocess — without this resolveCredentialEnv()
        // returns {} and the turn fails preflight with "no Anthropic credential".
        credentials: createCredentialStore(sessionOptions.credsDir),
        sandbox: sessionOptions.sandbox,
        attachToChat: sessionOptions.attachToChat,
      });
    },
    install: (prefix) => ({
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, "@anthropic-ai/claude-code"],
      display: `npm install --global --prefix ${prefix} @anthropic-ai/claude-code`,
    }),
  });
}
