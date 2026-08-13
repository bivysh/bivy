// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineAgentIntegration, type AgentIntegrationOrigin } from "../definition.js";
import type { AgentInfo, AgentInstallCommand, AgentSessionOptions } from "../types.js";
import { codexSandboxPolicy, type SandboxTier } from "../../harness/sandbox.js";
import { codexCredentialPreflight } from "../../runtime/codex-preflight.js";
import {
  deleteCodexSession,
  discoverNativeCodexSessions,
  loadCodexTranscript,
  writeCodexRollout,
} from "../../runtime/codex-sessions.js";
import { ProtocolRuntime } from "../../runtime/protocol.js";
import { codexSlashCommands } from "../../runtime/slash-commands.js";
import type { AgentRuntime } from "../../runtime/types.js";

export const CODEX_TESTED_VERSION = "0.147.0";
const CODEX_AVAILABLE_CACHE = new Map<string, boolean>();

function codexCommand(): string {
  return process.env.BIVY_CODEX_BIN?.trim() || "codex";
}

export function codexCommandAvailable(): boolean {
  const command = codexCommand();
  const cached = CODEX_AVAILABLE_CACHE.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  const available = result.status === 0;
  CODEX_AVAILABLE_CACHE.set(command, available);
  return available;
}

export function invalidateCodexCommandProbe(): void {
  CODEX_AVAILABLE_CACHE.clear();
}

async function suggestCodexSessionName(firstPrompt: string, context: { cwd: string; model?: string }): Promise<string | undefined> {
  const prompt = firstPrompt.trim();
  if (!prompt) return undefined;
  const instruction = [
    "Name this coding-agent session from the user request below.",
    "Return only a concise title of 2-6 words, with no quotes, punctuation, prefix, or explanation.",
    "",
    prompt.slice(0, 4000),
  ].join("\n");
  return new Promise((resolve) => {
    const args = ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];
    if (context.model) args.push("--model", context.model);
    args.push(instruction);
    const child = spawn(codexCommand(), args, { cwd: context.cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(undefined); }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(undefined); return; }
      let text = "";
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
          if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) text = event.item.text;
        } catch { /* ignore non-JSON output */ }
      }
      const clean = text.replace(/[\r\n'"`]/g, " ").replace(/\p{Control}/gu, "").replace(/\s+/g, " ").trim().replace(/[.?!,:;–—-]+$/g, "").slice(0, 60).trim();
      resolve(clean || undefined);
    });
  });
}

export function codexAppServerRuntime(tier?: SandboxTier): AgentRuntime {
  const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "codex-app-server-shim.mjs");
  const policy = tier ? codexSandboxPolicy(tier) : undefined;
  return new ProtocolRuntime({
    id: "codex-approvals",
    displayName: "Codex",
    command: process.execPath,
    args: [bridge],
    ...(policy ? { env: { BIVY_CODEX_SANDBOX: policy.sandbox, BIVY_CODEX_APPROVAL_POLICY: policy.approvalPolicy } } : {}),
    preflight: (env: Record<string, string | undefined>) => codexCredentialPreflight(env),
    catalog: [{
      id: "openai-codex",
      name: "OpenAI Codex (ChatGPT)",
      oauth: true,
      // Session-less placeholder list shown in the picker before a Codex thread
      // opens; once the app-server's `model/list` handshake lands, the shim
      // replaces this with the authoritative per-account set. Kept current with
      // the Codex CLI's listed (non-hidden) models — the retired gpt-5-codex/gpt-5
      // generation was superseded by the GPT-5.6 Sol frontier line.
      models: [
        { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true },
        { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", reasoning: true },
      ],
    }],
    capabilities: {
      toolInterception: true,
      modelSelection: true,
      resume: true,
      usageReporting: true,
      interactiveTui: codexCommandAvailable(),
      nativeSessionDiscovery: true,
      nativeSessionAdoption: true,
    },
    resumable: true,
    loadHistory: (sessionId) => loadCodexTranscript(sessionId),
    deleteHistory: (sessionId) => void deleteCodexSession(sessionId),
    writeHistory: (history, ctx) => writeCodexRollout(history, ctx.cwd || ctx.workspace),
    suggestName: suggestCodexSessionName,
    discoverNativeSessions: () => discoverNativeCodexSessions(),
    slashCommands: codexSlashCommands(),
    interactiveTui: ({ sessionRef, env }) => (sessionRef ? { command: codexCommand(), args: ["resume", sessionRef], env } : null),
  });
}

export function codexIntegration(origin: AgentIntegrationOrigin) {
  return defineAgentIntegration<AgentInfo, AgentSessionOptions, AgentRuntime, AgentInstallCommand>({
    id: "codex-approvals",
    visible: true,
    origin,
    describe: () => {
      const installed = codexCommandAvailable();
      return {
        id: "codex-approvals",
        executionMode: "protocol",
        displayName: "Codex",
        description: "The operator-installed Codex CLI connected through its app-server protocol for governed tool calls and native thread resume.",
        status: installed ? "available" : "external",
        packageName: "@openai/codex",
        language: "Rust",
        capabilities: {
          toolInterception: true,
          modelSelection: true,
          resume: true,
          packages: false,
          fork: true,
          usageReporting: true,
          interactiveTui: installed,
          nativeSessionDiscovery: true,
          nativeSessionAdoption: true,
        },
        nativeSandbox: true,
        supportTier: "supported",
        testedVersion: CODEX_TESTED_VERSION,
        source: origin,
        authOwner: "agent",
        notes: installed
          ? "Uses Codex's native app-server, login, configuration, rollouts, model selection, and sandbox while Bivy mediates structured tool approvals."
          : "Install and sign in to Codex on this node; Bivy will connect to that existing agent.",
        install: installed ? undefined : {
          label: "Install Codex",
          description: "Installs OpenAI's Codex CLI on this node.",
          command: "npm install --global @openai/codex",
        },
      };
    },
    create: (options) => {
      if (!codexCommandAvailable()) throw new Error(`Codex command not found on PATH: ${codexCommand()}`);
      return codexAppServerRuntime(options.sandbox);
    },
    install: (prefix) => ({
      command: "npm",
      args: ["install", "--global", "--prefix", prefix, "@openai/codex"],
      display: `npm install --global --prefix ${prefix} @openai/codex`,
    }),
  });
}
