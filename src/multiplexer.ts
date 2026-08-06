// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { execFile } from "node:child_process";

/**
 * Discover terminal-multiplexer sessions on the node's machine so the app can
 * reach sessions that were NOT started by Bivy. Attaching itself needs no special
 * path: it's a daemon-owned run-terminal whose command is `tmux attach -t <name>`
 * (etc.), so a phone and a terminal share one live view.
 *
 * Discovery is best-effort: a multiplexer that isn't installed is simply
 * skipped, never an error.
 *
 * Today only the web app drives this (the CLI `bivy attach --tmux` was removed).
 * A future `bivy run --tmux <name>` could re-add a terminal entry point on top of
 * the same discovery + `terminal.open.mux` plumbing.
 */

export type MultiplexerKind = "tmux" | "zellij" | "screen";

export interface MultiplexerSession {
  multiplexer: MultiplexerKind;
  /** Session name used to attach (`-t <name>` / `attach <name>` / `-r <name>`). */
  name: string;
  attached: boolean;
  /** A stable target tag (e.g. "tmux:work") used to dedupe attach terminals. */
  target: string;
}

function runCmd(command: string, args: string[], timeoutMs = 2500): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Strip ANSI so multiplexers that colorize `list-sessions` (zellij) parse cleanly.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Pure parsers (exported for tests) — take a multiplexer's raw stdout and return
// sessions. Kept separate from process spawning so parsing is verifiable.
// tmux is asked for "<attached>:<name>" — `session_attached` is a single char
// ("1" when a client is attached), so a fixed 2-char prefix delimits the name
// without an exotic separator (a literal tab is mishandled by tmux -F), and the
// name may itself contain ":".
export function parseTmux(stdout: string): MultiplexerSession[] {
  return stdout.split("\n").filter((line) => /^[01]:/.test(line)).map((line) => {
    const attached = line[0] === "1";
    const name = line.slice(2);
    return { multiplexer: "tmux" as const, name, attached, target: `tmux:${name}` };
  });
}

export function parseZellij(stdout: string): MultiplexerSession[] {
  return stripAnsi(stdout).split("\n").map((line) => line.trim())
    // Lines look like: "name [Created ...] (current)" or "name (EXITED ...)".
    // Drop exited sessions — they can't be attached to.
    .filter((line) => line && !/EXITED/i.test(line))
    .map((line) => {
      const name = line.split(/\s+/)[0];
      const attached = /\(current\)/i.test(line);
      return { multiplexer: "zellij" as const, name, attached, target: `zellij:${name}` };
    });
}

export function parseScreen(stdout: string): MultiplexerSession[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) => /^\d+\./.test(line)).map((line) => {
    const name = line.split(/\s+/)[0]; // e.g. "12345.work"
    const attached = /\(Attached\)/i.test(line);
    return { multiplexer: "screen" as const, name, attached, target: `screen:${name}` };
  });
}

export async function listTmux(): Promise<MultiplexerSession[]> {
  // A tab-delimited format keeps parsing robust against names with spaces.
  const { code, stdout } = await runCmd("tmux", ["list-sessions", "-F", "#{session_attached}:#{session_name}"]);
  return code === 0 ? parseTmux(stdout) : [];
}

export async function listZellij(): Promise<MultiplexerSession[]> {
  const { code, stdout } = await runCmd("zellij", ["list-sessions", "--no-formatting"]);
  // Older zellij lacks --no-formatting; retry without it.
  const out = code === 0 ? stdout : (await runCmd("zellij", ["list-sessions"])).stdout;
  return parseZellij(out);
}

export async function listScreen(): Promise<MultiplexerSession[]> {
  // `screen -ls` exits non-zero (1) when listing; parse stdout regardless.
  const { stdout } = await runCmd("screen", ["-ls"]);
  return parseScreen(stdout);
}

export async function listMultiplexerSessions(): Promise<MultiplexerSession[]> {
  const [tmux, zellij, screen] = await Promise.all([
    listTmux().catch(() => []),
    listZellij().catch(() => []),
    listScreen().catch(() => []),
  ]);
  return [...tmux, ...zellij, ...screen];
}

/** The PTY command that attaches to a given multiplexer session. */
export function attachCommand(kind: MultiplexerKind, name: string): { command: string; args: string[] } {
  switch (kind) {
    case "tmux": return { command: "tmux", args: ["attach", "-t", name] };
    case "zellij": return { command: "zellij", args: ["attach", name] };
    case "screen": return { command: "screen", args: ["-r", name] };
  }
}
