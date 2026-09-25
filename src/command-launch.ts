// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn } from "node:child_process";
import os from "node:os";

import { loadPty } from "./terminal.js";

/** Where a short-lived server command's output and lifecycle are reported. */
export interface CommandHandlers {
  onOutput: (stream: "stdout" | "stderr", text: string) => void;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** A running short-lived server command, independent of how it was launched. */
export interface CommandHandle {
  usesPty: boolean;
  write: (text: string) => void;
  /** SIGINT to the command (its whole process group under a PTY). */
  interrupt: () => void;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const signalNames = new Map(Object.entries(os.constants.signals).map(([name, num]) => [num, name as NodeJS.Signals]));

/**
 * Keep terminal semantics opt-in for short-lived commands. Native interactive
 * commands must set requiresTty and run under node-pty (the same dependency the
 * interactive terminals use); ordinary commands stay on direct pipes.
 */
export function launchCommand(spec: CommandSpec, requiresTty: boolean | undefined, handlers: CommandHandlers): CommandHandle {
  return requiresTty ? launchPty(spec, handlers) : launchPipes(spec, handlers);
}

function launchPipes({ command, args, cwd, env }: CommandSpec, handlers: CommandHandlers): CommandHandle {
  const child = spawn(command, args, { cwd, env });
  child.stdout.on("data", (data) => handlers.onOutput("stdout", String(data)));
  child.stderr.on("data", (data) => handlers.onOutput("stderr", String(data)));
  child.on("error", handlers.onError);
  child.on("exit", handlers.onExit);
  return {
    usesPty: false,
    write: (text) => child.stdin.write(text),
    interrupt: () => child.kill("SIGINT"),
  };
}

function launchPty({ command, args, cwd, env }: CommandSpec, handlers: CommandHandlers): CommandHandle {
  let proc: ReturnType<ReturnType<typeof loadPty>["spawn"]>;
  try {
    proc = loadPty().spawn(command, args, { name: env.TERM ?? "xterm-256color", cols: 120, rows: 40, cwd, env });
  } catch (error) {
    // Match child_process: a launch failure is reported asynchronously, not thrown.
    queueMicrotask(() => handlers.onError(error instanceof Error ? error : new Error(String(error))));
    return { usesPty: true, write: () => {}, interrupt: () => {} };
  }
  // A PTY merges stdout and stderr into one stream.
  proc.onData((text) => handlers.onOutput("stdout", text));
  proc.onExit(({ exitCode, signal }) => handlers.onExit(signal ? null : exitCode, signal ? signalNames.get(signal) ?? null : null));
  return {
    usesPty: true,
    write: (text) => proc.write(text),
    interrupt: () => {
      // node-pty makes the child a session (and process-group) leader, so a
      // negative pid reaches anything it forked too.
      try {
        process.kill(-proc.pid, "SIGINT");
      } catch {
        try { proc.kill("SIGINT"); } catch { /* already exited */ }
      }
    },
  };
}
