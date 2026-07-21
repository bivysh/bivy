// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — MCP effect boundary (governing tool calls).
//
// Second pillar of "govern the substrate, not the agent". MCP (Model Context
// Protocol) is a wire standard every serious agent now speaks — Claude Code,
// Codex, Goose, Gemini, OpenCode — so instead of teaching Bivy each agent's
// chat protocol, we sit in front of the agent's MCP servers and mediate the
// JSON-RPC. Rewriting an agent's MCP config so each server launches as
// `bivy mcp-proxy -- <real server cmd>` means EVERY MCP tool call flows through
// Bivy for inventory, policy, and logging — with zero agent-specific code.
//
// MCP stdio transport is newline-delimited JSON-RPC 2.0 (one message per line).
// The mediator below is transport-free and fully unit-testable: it takes decoded
// messages and says whether to forward them or short-circuit a denied tool call
// back to the agent. runMcpProxy() wraps it around a real child process's stdio.
//
// Unit-tested in test/harness-mcp-proxy.test.ts.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A JSON-RPC 2.0 message (request, response, or notification). */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

export interface McpDecision {
  allow: boolean;
  /** Shown to the agent (as a tool error) and logged when a call is denied. */
  reason?: string;
}

/** Consulted before an MCP `tools/call` is forwarded to the real server. */
export type McpDecider = (toolName: string, args: unknown) => McpDecision | Promise<McpDecision>;

export type McpEvent =
  | { type: "tools"; server: string; tools: { name: string; description?: string }[] }
  | { type: "call"; server: string; tool: string; args: unknown; allowed: boolean; reason?: string }
  | { type: "result"; server: string; id: string | number | null; isError: boolean };

export interface McpMediatorOptions {
  decide: McpDecider;
  onEvent?: (event: McpEvent) => void;
  /** Logical name of the proxied server (for events/logs). */
  server?: string;
}

/** What to do with a client→server message after mediation. */
export interface ClientOutcome {
  /** Forward this message to the real server. */
  forward?: JsonRpcMessage;
  /** Short-circuit: send this straight back to the agent (a denied tool call). */
  reply?: JsonRpcMessage;
}

/**
 * Transport-free MCP JSON-RPC mediator. Feed it decoded messages in each
 * direction; it enforces policy on `tools/call`, inventories `tools/list`
 * results, and otherwise passes everything through untouched.
 */
export class McpMediator {
  private readonly decide: McpDecider;
  private readonly onEvent: (event: McpEvent) => void;
  private readonly server: string;
  /** Request ids we short-circuited (denied) — never expect a server reply for them. */
  private readonly denied = new Set<string | number>();

  constructor(options: McpMediatorOptions) {
    this.decide = options.decide;
    this.onEvent = options.onEvent ?? (() => {});
    this.server = options.server ?? "mcp";
  }

  /** Mediate one message coming from the agent (client) toward the server. */
  async handleClientMessage(msg: JsonRpcMessage): Promise<ClientOutcome> {
    if (msg.method !== "tools/call") return { forward: msg };
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof params.name === "string" ? params.name : "";
    const args = params.arguments;
    let decision: McpDecision;
    try {
      decision = await this.decide(tool, args);
    } catch {
      // A failing policy check must fail safe (deny), not crash the proxy.
      decision = { allow: false, reason: "Policy check failed." };
    }
    this.onEvent({ type: "call", server: this.server, tool, args, allowed: decision.allow, reason: decision.reason });
    if (decision.allow) return { forward: msg };

    // Denied: reply to the agent with an MCP tool *result* carrying isError,
    // so the agent sees a normal tool failure rather than a transport crash.
    if (msg.id !== undefined && msg.id !== null) this.denied.add(msg.id);
    return {
      reply: {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text", text: decision.reason || `Blocked by Bivy policy: ${tool}` }],
        },
      },
    };
  }

  /** Observe one message coming from the server toward the agent (client). */
  handleServerMessage(msg: JsonRpcMessage): { forward: JsonRpcMessage } {
    const result = msg.result as { tools?: unknown; isError?: unknown } | undefined;
    if (result && Array.isArray(result.tools)) {
      const tools = result.tools
        .map((t) => (t && typeof t === "object" ? (t as { name?: unknown; description?: unknown }) : {}))
        .filter((t) => typeof t.name === "string")
        .map((t) => ({ name: t.name as string, description: typeof t.description === "string" ? t.description : undefined }));
      this.onEvent({ type: "tools", server: this.server, tools });
    } else if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const isError = Boolean((msg.result as { isError?: unknown } | undefined)?.isError) || msg.error !== undefined;
      this.onEvent({ type: "result", server: this.server, id: msg.id, isError });
    }
    return { forward: msg };
  }

  wasDenied(id: string | number): boolean {
    return this.denied.has(id);
  }
}

export interface RunMcpProxyOptions extends McpMediatorOptions {
  /** The real MCP server command to spawn. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Agent-facing input; defaults to process.stdin (injectable for tests). */
  agentInput?: Readable;
  /** Agent-facing output; defaults to process.stdout (injectable for tests). */
  agentOutput?: Writable;
}

/**
 * Wrap the mediator around a real MCP server subprocess: agent ⇄ (this process's
 * stdio) ⇄ mediator ⇄ child stdio ⇄ real server. Newline-delimited JSON-RPC in
 * both directions. Resolves with the child's exit code.
 */
export function runMcpProxy(options: RunMcpProxyOptions): Promise<number> {
  const mediator = new McpMediator(options);
  const agentIn: Readable = options.agentInput ?? process.stdin;
  const agentOut: Writable = options.agentOutput ?? process.stdout;
  const child = spawn(options.command, options.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
  });

  const writeToAgent = (msg: JsonRpcMessage) => agentOut.write(`${JSON.stringify(msg)}\n`);
  const writeToServer = (msg: JsonRpcMessage) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  // Agent → (mediate) → server, or short-circuit back to the agent.
  const fromAgent = createInterface({ input: agentIn });
  fromAgent.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not valid JSON-RPC — drop it rather than forward a malformed frame.
      return;
    }
    void mediator.handleClientMessage(msg).then((outcome) => {
      if (outcome.reply) writeToAgent(outcome.reply);
      else if (outcome.forward) writeToServer(outcome.forward);
    });
  });
  // When the agent closes its side, close the server's stdin so it sees EOF and
  // shuts down (otherwise the child — and this promise — would hang forever).
  fromAgent.on("close", () => child.stdin.end());

  // Server → (observe) → agent.
  const fromServer = createInterface({ input: child.stdout });
  fromServer.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    writeToAgent(mediator.handleServerMessage(msg).forward);
  });

  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}
