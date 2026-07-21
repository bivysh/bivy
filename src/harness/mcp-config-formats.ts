// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — MCP config writers for non-JSON formats.
//
// Codex stores MCP servers in TOML (~/.codex/config.toml, `[mcp_servers.<name>]`)
// and Goose in YAML (~/.config/goose/config.yaml, `extensions:` with `cmd`/`args`).
// routeThroughProxy handles the universal JSON shape; these are the two
// format-specific writers that reroute stdio servers through `bivy mcp-proxy` in
// TOML/YAML, so Codex and Goose join MCP governance too.
//
// These are deliberately focused, line-oriented transforms for the common
// single-line `command`/`args` (TOML) and `cmd`/`args: [..]` (YAML) shapes — not
// full TOML/YAML parsers. Anything they don't recognize is left untouched
// (rewritten: []), which is safe: injection is opt-in and the caller restores the
// exact original bytes on session end regardless. Pure string→string, unit-tested
// in test/harness-mcp-formats.test.ts.

import { PROXY_MARKER, type ProxyLauncher } from "./mcp-config.js";

export interface FormatInjectResult {
  content: string;
  rewritten: string[];
}

function proxyArgs(launcher: ProxyLauncher, server: string, command: string, origArgs: string[]): string[] {
  return [...(launcher.argsPrefix ?? []), PROXY_MARKER, "--server", server, "--", command, ...origArgs];
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

/** Parse a TOML inline string array `["a", "b"]` (best-effort) into JS strings. */
function parseTomlArray(literal: string): string[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? ""));
  return out;
}

/**
 * Rewrite `[mcp_servers.<name>]` TOML tables so each stdio server launches
 * through the proxy. Handles single-line `command = "…"` and `args = [ … ]`.
 */
export function injectTomlMcp(content: string, launcher: ProxyLauncher): FormatInjectResult {
  const lines = content.split("\n");
  const rewritten: string[] = [];
  // First pass: find each [mcp_servers.NAME] section's line range + command/args.
  let i = 0;
  const proxyCmd = launcher.command;
  while (i < lines.length) {
    const header = /^\s*\[mcp_servers\.([A-Za-z0-9_.-]+)\]\s*$/.exec(lines[i]);
    if (!header) { i++; continue; }
    const name = header[1];
    let end = i + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    // Locate command/args lines in [i+1, end).
    let cmdIdx = -1;
    let argsIdx = -1;
    for (let j = i + 1; j < end; j++) {
      if (cmdIdx < 0 && /^\s*command\s*=/.test(lines[j])) cmdIdx = j;
      if (argsIdx < 0 && /^\s*args\s*=\s*\[/.test(lines[j])) argsIdx = j;
    }
    if (cmdIdx >= 0) {
      const cmdVal = /=\s*"((?:[^"\\]|\\.)*)"/.exec(lines[cmdIdx]) || /=\s*'([^']*)'/.exec(lines[cmdIdx]);
      const command = cmdVal ? (cmdVal[1] ?? "") : "";
      if (command && command !== proxyCmd) {
        const origArgs = argsIdx >= 0 ? parseTomlArray(lines[argsIdx].slice(lines[argsIdx].indexOf("["))) : [];
        lines[cmdIdx] = lines[cmdIdx].replace(/=\s*("(?:[^"\\]|\\.)*"|'[^']*')/, `= ${JSON.stringify(proxyCmd)}`);
        const newArgsLine = `args = ${tomlStringArray(proxyArgs(launcher, name, command, origArgs))}`;
        if (argsIdx >= 0) lines[argsIdx] = lines[argsIdx].replace(/args\s*=\s*\[.*\]/, newArgsLine);
        else lines.splice(cmdIdx + 1, 0, newArgsLine);
        rewritten.push(name);
      }
    }
    i = end;
  }
  return { content: lines.join("\n"), rewritten };
}

/** Parse a YAML inline flow array `[a, "b"]` into JS strings (best-effort). */
function parseYamlFlowArray(literal: string): string[] {
  const inner = literal.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s.length > 0);
}

function yamlFlowArray(values: string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

/**
 * Rewrite Goose `extensions:` YAML so each stdio extension launches through the
 * proxy. Handles the common shape with `cmd:` and an inline `args: [ … ]` at a
 * deeper indent than the extension name. Block-sequence args (`- item` lines) are
 * left untouched (safe no-op) rather than risk a malformed rewrite.
 */
export function injectYamlMcp(content: string, launcher: ProxyLauncher): FormatInjectResult {
  const lines = content.split("\n");
  const rewritten: string[] = [];
  let inExtensions = false;
  let extName: string | null = null;
  let extIndent = -1;
  let cmdIdx = -1;
  let cmdValue = "";
  let argsIdx = -1;

  const flush = () => {
    if (extName && cmdIdx >= 0 && cmdValue && cmdValue !== launcher.command) {
      const origArgs = argsIdx >= 0 ? parseYamlFlowArray(lines[argsIdx].slice(lines[argsIdx].indexOf("["))) : [];
      const indent = lines[cmdIdx].slice(0, lines[cmdIdx].length - lines[cmdIdx].trimStart().length);
      lines[cmdIdx] = `${indent}cmd: ${JSON.stringify(launcher.command)}`;
      const newArgs = `${indent}args: ${yamlFlowArray(proxyArgs(launcher, extName, cmdValue, origArgs))}`;
      if (argsIdx >= 0) lines[argsIdx] = newArgs;
      else lines.splice(cmdIdx + 1, 0, newArgs);
      rewritten.push(extName);
    }
    extName = null; cmdIdx = -1; cmdValue = ""; argsIdx = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*extensions\s*:/.test(line)) { inExtensions = true; continue; }
    if (!inExtensions) continue;
    const indent = line.length - line.trimStart().length;
    if (line.trim() && indent === 0) { flush(); inExtensions = false; continue; }
    // An extension name: `  <name>:` directly under extensions.
    const nameMatch = /^(\s+)([A-Za-z0-9_.-]+)\s*:\s*$/.exec(line);
    if (nameMatch && (extIndent < 0 || nameMatch[1].length <= extIndent || extName === null)) {
      // New extension block starts.
      flush();
      extName = nameMatch[2];
      extIndent = nameMatch[1].length;
      continue;
    }
    if (extName) {
      const cmd = /^\s+cmd\s*:\s*(.+)$/.exec(line);
      if (cmd) { cmdIdx = i; cmdValue = cmd[1].trim().replace(/^["']|["']$/g, ""); continue; }
      const args = /^\s+args\s*:\s*(\[.*\])\s*$/.exec(line);
      if (args) { argsIdx = i; continue; }
    }
  }
  flush();
  return { content: lines.join("\n"), rewritten };
}
