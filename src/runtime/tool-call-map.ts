// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Normalized tool-call taxonomy (Universal Agent Harness — fidelity layer).
//
// Different agents name and shape their tool calls differently, but they mostly
// converge on a handful of *kinds* (run a shell command, read a file, edit a
// file, search, fetch a URL, write a plan). `mapToolCall` collapses a raw
// (toolName, input) pair into one normalized `ToolCallDetail` so the PWA can
// render every agent's tool activity the same way — a shell command + exit code,
// a unified diff, a file read — instead of an agent-specific opaque blob.
//
// Design mirrors extractTokenUsage in cli-parsers.ts: a SINGLE keyed mapper that
// scans many key spellings, rather than one bespoke mapper per agent. That is
// what makes the long tail cheap — a new CLI agent whose tools use ordinary
// names (bash/read/edit/…) gets normalized rendering for free, and one whose
// tools we don't recognize simply returns `undefined` and falls back to today's
// opaque passthrough. The daemon never acts on the result; it is display-only.
//
// Pure and dependency-free (no daemon knowledge), unit-tested in
// test/runtime-tool-call-map.test.ts.

import type { ToolCallDetail, ToolCallProvenance, ToolResultDetail } from "./types.js";

export interface ToolCallMapContext {
  provider?: string;
  protocol?: ToolCallProvenance["protocol"];
}

const RAW_LIMIT = 4096;

export function boundedToolPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length <= RAW_LIMIT) return value;
    return { truncated: true, preview: json.slice(0, RAW_LIMIT) };
  } catch {
    return { unreadable: true };
  }
}

function decorate<T extends Omit<ToolCallDetail, "meta">>(detail: T, toolName: string, input: unknown, context: ToolCallMapContext): ToolCallDetail {
  return {
    ...detail,
    meta: { version: 1, provider: context.provider ?? "unknown", protocol: context.protocol ?? "unknown", rawToolName: toolName },
    ...(input === undefined ? {} : { raw: boundedToolPayload(input) }),
  } as ToolCallDetail;
}

/** Lowercase and strip non-alphanumerics so "read_file", "Read", "readFile" and
 *  "read-file" all collapse to the same bucket key. */
function canon(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** First value among `keys` that is a non-empty string, else undefined. An array
 *  value (some agents pass argv) is joined with spaces so a `["ls","-la"]` command
 *  still renders. */
function str(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length) return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return (v as string[]).join(" ");
  }
  return undefined;
}

const SHELL = new Set([
  "bash", "sh", "shell", "run", "runcommand", "command", "commandexecution",
  "exec", "execute", "executecommand", "terminal", "runterminalcmd", "localshell",
]);
const READ = new Set(["read", "readfile", "view", "viewfile", "cat", "openfile", "fileread"]);
const WRITE = new Set(["write", "writefile", "create", "createfile", "newfile", "filewrite", "savefile"]);
const EDIT = new Set([
  "edit", "editfile", "multiedit", "strreplace", "strreplaceeditor", "replace",
  "applypatch", "patch", "filechange", "filechanges", "update", "modify",
]);
const SEARCH = new Set(["search", "grep", "glob", "ripgrep", "rg", "find", "findfiles", "codebasesearch", "filesearch"]);
const FETCH = new Set(["fetch", "webfetch", "httpfetch", "geturl", "browse", "curl", "openurl"]);
const PLAN = new Set(["plan", "updateplan", "setplan", "todo", "todowrite", "exitplanmode", "planmode"]);
// Sub-agent / delegation dispatch. Names lean specific (Claude's `Task`,
// `dispatch_agent`, `spawn_agent`, an explicit `delegate`) so an ordinary tool
// isn't misread as a delegation; a bare `agent`/`subagent` is included because
// those are only ever a hand-off. Kept conservative — an unrecognized name
// still falls through to the opaque default, never a false "Delegated".
const DELEGATE = new Set([
  "task", "agent", "subagent", "runagent", "runsubagent", "spawnagent",
  "dispatchagent", "delegate", "delegatetask", "agenttask", "startagent",
]);

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "fileName", "file", "target_file", "targetFile"];

/**
 * Classify one tool call into a normalized ToolCallDetail, or undefined when it
 * doesn't map to a known kind (the caller then leaves the tool block opaque).
 * Never throws — a weird/partial input degrades to undefined rather than failing
 * a live turn.
 */
export function mapToolCall(toolName: string, input: unknown, context: ToolCallMapContext = {}): ToolCallDetail | undefined {
  const key = canon(toolName);
  const o = asRecord(input);

  if (SHELL.has(key)) {
    const command = str(o, "command", "cmd", "script", "input", "args");
    return command ? decorate({ kind: "shell", command, ...(str(o, "cwd", "workdir", "workingDir", "directory") ? { cwd: str(o, "cwd", "workdir", "workingDir", "directory") } : {}) }, toolName, input, context) : undefined;
  }

  if (EDIT.has(key)) {
    let path = str(o, ...PATH_KEYS);
    // Codex `apply_patch`/`file_change` carries a `changes` map keyed by path.
    if (!path) {
      const changes = o.changes;
      if (changes && typeof changes === "object" && !Array.isArray(changes)) {
        const first = Object.keys(changes as Record<string, unknown>)[0];
        if (first) path = first;
      }
    }
    if (!path) return undefined;
    const oldText = str(o, "old_string", "oldString", "old", "before", "search");
    const newText = str(o, "new_string", "newString", "new", "after", "replace", "replacement");
    return decorate({ kind: "edit", path, ...(oldText ? { oldText } : {}), ...(newText ? { newText } : {}) }, toolName, input, context);
  }

  if (WRITE.has(key)) {
    const path = str(o, ...PATH_KEYS);
    return path ? decorate({ kind: "write", path }, toolName, input, context) : undefined;
  }

  if (READ.has(key)) {
    const path = str(o, ...PATH_KEYS);
    return path ? decorate({ kind: "read", path }, toolName, input, context) : undefined;
  }

  if (SEARCH.has(key)) {
    const query = str(o, "pattern", "query", "q", "search", "regex", "searchTerm");
    return query ? decorate({ kind: "search", query, ...(str(o, "path", "dir", "directory", "include") ? { path: str(o, "path", "dir", "directory", "include") } : {}) }, toolName, input, context) : undefined;
  }

  if (FETCH.has(key)) {
    const url = str(o, "url", "uri", "href", "link");
    return url ? decorate({ kind: "fetch", url }, toolName, input, context) : undefined;
  }

  if (PLAN.has(key)) {
    return decorate({ kind: "plan", ...(str(o, "plan", "text", "content", "message") ? { text: str(o, "plan", "text", "content", "message") } : {}) }, toolName, input, context);
  }

  if (DELEGATE.has(key)) {
    const label = str(o, "subagent_type", "subagentType", "agent", "agentType", "role", "name");
    const description = str(o, "description", "task", "prompt", "instructions", "goal", "message");
    return decorate({ kind: "delegation", ...(label ? { label } : {}), ...(description ? { description } : {}) }, toolName, input, context);
  }

  return undefined;
}

export function mapToolResult(result: unknown, isError = false): ToolResultDetail {
  const o = asRecord(result);
  const content = o.content ?? o.output ?? o.text ?? o.aggregated_output ?? result;
  const rawText = typeof content === "string" ? content : content == null ? "" : JSON.stringify(boundedToolPayload(content));
  const text = rawText.length > RAW_LIMIT ? rawText.slice(0, RAW_LIMIT) : rawText;
  const exit = o.exitCode ?? o.exit_code ?? o.code;
  return {
    ...(text ? { text } : {}),
    ...(typeof exit === "number" ? { exitCode: exit } : {}),
    ...(isError || o.isError === true || o.is_error === true ? { isError: true } : {}),
    ...(rawText.length > RAW_LIMIT ? { truncated: true } : {}),
  };
}
