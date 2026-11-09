// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Bivy's own agent tools (ask_user, notify_user, set_session_title, app_present,
// …) as data: the `bivy` command table (bin/cli-commands.mjs, read through
// `bivy help --json`) plus the tools installed plugins add (`bivy tools list`).
// Each call runs the matching `bivy` command, so a tool and its command share one
// implementation and error contract.
//
// Two delivery paths use this one source:
//  - `bivy mcp-serve` (mcp-serve-cli.ts) serves them over stdio MCP to agents
//    that read an MCP config (Codex, OpenCode, Grok, …).
//  - `BivyCliTools.provider()` hands them to the daemon's ToolProvider, which
//    agents with in-process tools (Claude's SDK MCP server, Pi's extensions)
//    register natively.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bivySessionEnv } from "../runtime/session-env.js";
import type { ToolProvider, ToolResult, ToolResultContent, ToolSpec } from "../runtime/types.js";

/** One `bivy` CLI run: its exit code and output. */
export interface CliResult { code: number; stdout: string; stderr: string }
export type RunBivy = (args: string[], signal?: AbortSignal) => Promise<CliResult>;

export interface CliTool { name: string; description: string; inputSchema: Record<string, unknown> }

/** Run this install's `bivy` (bin/bivy.mjs, two levels up from src/harness or
 *  dist/harness) with `env` laid over the daemon's own, in `cwd` (the session's
 *  workspace, so relative paths and git context are the agent's, not the daemon's). */
export function bivyCliRunner(env: Record<string, string | undefined>, cwd?: string): RunBivy {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/bivy.mjs");
  return (args, signal) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function readTools(runBivy: RunBivy, args: string[]): Promise<CliTool[]> {
  const result = await runBivy(args);
  try {
    const tools = (JSON.parse(result.stdout) as { tools?: CliTool[] }).tools ?? [];
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  } catch {
    return [];
  }
}

/** The tools the command table offers, or none when the CLI can't be asked. */
export const listCommandTools = (runBivy: RunBivy) => readTools(runBivy, ["help", "--json"]);
/** Tools installed plugins add, or none when there are none. */
export const listPluginTools = (runBivy: RunBivy) => readTools(runBivy, ["tools", "list", "--json"]);

export interface BivyToolOutput {
  isError: boolean;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
}

/** Run one command-table tool (`bivy tool <name> <json>`). */
export async function callCommandTool(runBivy: RunBivy, name: string, args: unknown, signal?: AbortSignal): Promise<BivyToolOutput> {
  const result = await runBivy(["tool", name, JSON.stringify(args ?? {})], signal);
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || (result.code === 0 ? "Done." : `bivy exited ${result.code}.`);
  return { isError: result.code !== 0, content: [{ type: "text", text }] };
}

/** Run one plugin tool (`bivy tools run <name> --input <json> --json`). */
export async function callPluginTool(runBivy: RunBivy, name: string, args: unknown, signal?: AbortSignal): Promise<BivyToolOutput> {
  const result = await runBivy(["tools", "run", name, "--input", JSON.stringify(args ?? {}), "--json"], signal);
  try {
    const body = JSON.parse(result.stdout) as { ok?: boolean; error?: string; content?: BivyToolOutput["content"]; structuredContent?: Record<string, unknown> };
    if (body.ok === false || result.code !== 0) return { isError: true, content: [{ type: "text", text: body.error ?? (result.stderr.trim() || "The tool failed.") }] };
    return { isError: false, content: body.content ?? [], ...(body.structuredContent !== undefined ? { structuredContent: body.structuredContent } : {}) };
  } catch {
    return { isError: true, content: [{ type: "text", text: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "The tool failed." }] };
  }
}

/** A ToolResult carries text blocks; anything else a plugin returns is kept as JSON text. */
function toToolResult(output: BivyToolOutput): ToolResult {
  const content: ToolResultContent[] = output.content.map((block) => block.type === "text" ? { type: "text", text: block.text ?? "" } : { type: "text", text: JSON.stringify(block) });
  if (output.structuredContent !== undefined && !content.length) content.push({ type: "text", text: JSON.stringify(output.structuredContent) });
  return { content, ...(output.isError ? { isError: true } : {}) };
}

/**
 * The daemon's catalog of Bivy tools for agents with in-process tools. The
 * ToolProvider contract lists tools synchronously at session start, so the
 * catalog keeps a snapshot: `ready()` loads it once, and a new provider
 * refreshes it in the background (at most every REFRESH_MS) so a plugin
 * installed now shows up in a later session.
 */
const REFRESH_MS = 30_000;
export class BivyCliTools {
  private commands: CliTool[] = [];
  private plugins: CliTool[] = [];
  private loading: Promise<void> | undefined;
  private loaded: Promise<void> | undefined;
  private loadedAt = 0;

  /** `endpoint`: this node's URL, so the CLI reaches this node and no other. */
  constructor(private readonly endpoint: string, private readonly runnerFor: (env: Record<string, string | undefined>, cwd?: string) => RunBivy = bivyCliRunner) {}

  private refresh(): Promise<void> {
    const run = this.runnerFor({ BIVY_NODE_URL: this.endpoint });
    this.loading ??= Promise.all([listCommandTools(run), listPluginTools(run)])
      .then(([commands, plugins]) => {
        this.loadedAt = Date.now();
        this.commands = commands;
        const own = new Set(commands.map((tool) => tool.name));
        this.plugins = plugins.filter((tool) => !own.has(tool.name));
      })
      .finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /** Resolves once the first snapshot is in. */
  ready(): Promise<void> {
    return this.loaded ??= this.refresh();
  }

  /** The tools for one session; `sessionId()` is read at call time (a new
   *  session's id may arrive after its tools are built). Each call runs in
   *  `workspace`, where the agent itself runs, so `app_publish manifest.json`
   *  or `automation_plan` resolve against the session's files. */
  provider(sessionId: () => string | undefined, workspace?: string): ToolProvider {
    const { commands, plugins } = this;
    if (Date.now() - this.loadedAt > REFRESH_MS) void this.refresh().catch(() => undefined);
    const spec = (tool: CliTool): ToolSpec => ({ name: tool.name, description: tool.description, promptSnippet: tool.description, parameters: tool.inputSchema });
    const isCommand = new Set(commands.map((tool) => tool.name));
    const isPlugin = new Set(plugins.map((tool) => tool.name));
    return {
      list: () => [...commands, ...plugins].map(spec),
      invoke: async (name, _toolCallId, params, signal) => {
        const id = sessionId();
        if (!id) return { content: [{ type: "text", text: `${name} failed: this session has no id yet.` }], isError: true };
        const run = this.runnerFor({ ...bivySessionEnv(id), BIVY_NODE_URL: this.endpoint }, workspace);
        if (isCommand.has(name)) return toToolResult(await callCommandTool(run, name, params, signal));
        if (isPlugin.has(name)) return toToolResult(await callPluginTool(run, name, params, signal));
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      },
    };
  }
}

/** One ToolProvider offering every tool of `providers`, the first owner of a name winning. */
export function combineToolProviders(...providers: ToolProvider[]): ToolProvider {
  const owners = new Map<string, ToolProvider>();
  const specs: ToolSpec[] = [];
  for (const provider of providers) {
    for (const spec of provider.list()) {
      if (owners.has(spec.name)) continue;
      owners.set(spec.name, provider);
      specs.push(spec);
    }
  }
  return {
    list: () => specs,
    invoke: (name, toolCallId, params, signal) => {
      const owner = owners.get(name);
      return owner ? owner.invoke(name, toolCallId, params, signal) : Promise.resolve({ content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
    },
  };
}
