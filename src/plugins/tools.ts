// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Running a tool a plugin contributes. A tool is a command: Bivy starts it as a
// child process (never inside the daemon), writes the input as JSON on stdin,
// and reads its answer from stdout — JSON when it parses, text otherwise. The
// same runner serves agents (`bivy tool run`, MCP) and chat widgets
// (`bivy.call`), so a tool behaves identically wherever it is called from.
import { spawn } from "node:child_process";
import { defaultDataDir } from "../data-dir.js";
import type { PluginToolContribution } from "../plugin-sdk/index.js";
import { findContribution, type Installed } from "./contributions.js";

export const DEFAULT_TOOL_TIMEOUT_SECONDS = 30;
/** What a tool may print; enough for a table or a status, not a log dump. */
export const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export class ToolInputError extends Error {}

/**
 * A tool a chat widget asked for. A widget is agent-written code running in the
 * chat, so it gets only the tools whose plugin offers them to widgets.
 */
export function widgetTool(name: string, dataDir = defaultDataDir()): Installed<PluginToolContribution> {
  const tool = findContribution("tools", name, dataDir);
  if (!tool) throw new Error(`No plugin on this machine provides a tool called "${name}".`);
  if (!tool.item.widgets) throw new Error(`The tool "${name}" is for agents only; its plugin does not offer it to widgets.`);
  return tool;
}

/** Check input against the tool's declared fields: required ones present, types right, nothing else. */
export function checkToolInput(tool: PluginToolContribution, input: Record<string, unknown>): void {
  const fields = tool.input ?? {};
  for (const [key, field] of Object.entries(fields)) {
    const value = input[key];
    if (value === undefined) {
      if (field.required) throw new ToolInputError(`${tool.name} needs "${key}".`);
      continue;
    }
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actual !== field.type) throw new ToolInputError(`${tool.name}: "${key}" must be ${field.type === "array" ? "an array" : `a ${field.type}`}.`);
  }
  const unknown = Object.keys(input).filter((key) => !(key in fields));
  if (unknown.length) throw new ToolInputError(`${tool.name} does not take ${unknown.map((key) => `"${key}"`).join(", ")}.`);
}

/** The JSON Schema for a tool's input, for MCP clients. */
export function toolInputSchema(tool: PluginToolContribution): Record<string, unknown> {
  const fields = tool.input ?? {};
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, { type: field.type, ...(field.description ? { description: field.description } : {}) }])),
    required: Object.entries(fields).filter(([, field]) => field.required).map(([key]) => key),
    additionalProperties: false,
  };
}

export async function runPluginTool(
  installed: Installed<PluginToolContribution>,
  input: Record<string, unknown>,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; sessionId?: string },
): Promise<ToolResult> {
  const tool = installed.item;
  checkToolInput(tool, input);
  const args = (tool.args ?? []).map((arg) => arg.replaceAll("{plugin}", installed.dir));
  const command = tool.command.replaceAll("{plugin}", installed.dir);
  const timeoutMs = (tool.timeoutSeconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS) * 1000;
  return await new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), BIVY_PLUGIN_ROOT: installed.dir, BIVY_TOOL: tool.name, ...(opts.sessionId ? { BIVY_SESSION_ID: opts.sessionId } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${tool.name} took longer than ${timeoutMs / 1000}s.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TOOL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${tool.name} printed more than ${MAX_TOOL_OUTPUT_BYTES / 1024} KB.`)));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 16 * 1024) err.push(chunk);
    });
    child.on("error", (error) => finish(() => reject(new Error(`${tool.name} could not start: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      const text = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0) {
        const detail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(-5).join("\n");
        reject(new Error(`${tool.name} failed (exit ${code})${detail ? `: ${detail}` : ""}`));
        return;
      }
      let structured: unknown;
      try { structured = text ? JSON.parse(text) : undefined; } catch { structured = undefined; }
      resolve({ content: [{ type: "text", text }], ...(structured !== undefined ? { structuredContent: structured } : {}) });
    }));
    child.stdin.on("error", () => { /* a tool that ignores its input may close stdin early */ });
    child.stdin.end(JSON.stringify(input));
  });
}
