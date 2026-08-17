// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";

/**
 * Raw-TTY bridge for `bivy run` and `bivy resume`.
 *
 * The agent's PTY lives in the node daemon; this process is just a client that
 * binds the local terminal to it: local keystrokes become `terminal.input`, the
 * daemon's output is written raw to stdout, and window resizes are forwarded.
 * Because the PTY is daemon-owned, detaching here (Ctrl-\ twice, or losing the
 * connection) leaves the session running so you can rejoin it later from another
 * terminal (`bivy resume`), a phone, or the web app.
 *
 * Modes:
 *   --run <specJson>   open a fresh run-terminal for a resolved agent command
 *   --attach <termId>  bind to an existing run-terminal (replays scrollback)
 *
 * With `--run --no-follow` the terminal is started but never bound to the local
 * TTY: the daemon keeps the PTY running and this process returns immediately, so
 * `bivy run <agent> --no-follow` launches a background session you rejoin later.
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

/**
 * Undo the terminal modes a full-screen TUI (Claude Code, Codex, vim) turns on:
 * leave the alternate screen, re-show the cursor, and switch off bracketed
 * paste, focus reporting, mouse tracking, application cursor/keypad keys and
 * any kitty keyboard-protocol flags.
 *
 * Needed because the daemon-side PTY can die without the TUI restoring the
 * terminal itself: a "continue as chat" takeover kills the agent's PTY, and
 * TerminalManager.close() deliberately drops its final output — the very chunk
 * that would have carried the TUI's own restore sequences. The same applies to
 * a Ctrl-\ detach, where the TUI keeps running remotely and never resets the
 * local terminal. Without this, the user's original terminal is left in those
 * modes and every mouse move, focus change or paste smears escape garbage over
 * the shell prompt. Each sequence is a no-op when its mode was never enabled.
 */
const TTY_MODE_RESET =
  "\x1b[?1049l" + // leave the alternate screen
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" + // mouse tracking off
  "\x1b[<u" + // pop kitty keyboard-protocol flags (no-op if never pushed)
  "\x1b[?1l\x1b>" + // cursor keys + keypad back to normal mode
  "\x1b[?25h" + // cursor visible
  "\x1b[0m"; // reset colors/attributes

type RunSpec = { agent?: string; label?: string; name?: string; model?: string; command: string; args?: string[]; workspace?: string; sessionId?: string };

type Args = {
  url: string;
  token?: string;
  mode: "run" | "attach";
  run?: RunSpec;
  termId?: string;
  noFollow?: boolean;
};

function parseArgs(argv: string[]): Args {
  let url = process.env.BIVY_URL || `http://localhost:${process.env.PORT || "4317"}`;
  let token = process.env.BIVY_DEVICE_TOKEN || undefined;
  let mode: Args["mode"] = "attach";
  let run: RunSpec | undefined;
  let termId: string | undefined;
  let noFollow = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) url = argv[++i];
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--token" && argv[i + 1]) token = argv[++i];
    else if (arg.startsWith("--token=")) token = arg.slice("--token=".length);
    else if (arg === "--run" && argv[i + 1]) { mode = "run"; run = JSON.parse(argv[++i]); }
    else if (arg === "--attach" && argv[i + 1]) { mode = "attach"; termId = argv[++i]; }
    else if (arg === "--no-follow") noFollow = true;
  }
  return { url: url.replace(/\/+$/, ""), token, mode, run, termId, noFollow };
}

function wsUrl(baseUrl: string, token?: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return u.toString();
}

function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

/**
 * Bind the local TTY to a daemon-owned terminal until it exits or the user
 * detaches. `open` sends the message that starts/attaches the terminal once the
 * socket is ready; the returned promise resolves with the process exit code.
 */
function bridge(args: Args, open: (ws: WebSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl(args.url, args.token));
    let termId = args.termId;
    let bound = false;
    let detachArmed = 0;
    let settled = false;
    const inputDecoder = new StringDecoder("utf8");

    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;

    let modesReset = false;
    // Reset TUI terminal modes exactly once, and only if a terminal was ever
    // bound (before that, no TUI output has touched this terminal). Callers on
    // the message paths invoke this BEFORE printing their exit message so the
    // message lands on the primary screen, not the alternate screen the reset
    // just left (where it would vanish).
    const resetModes = () => {
      if (modesReset || !bound) return;
      modesReset = true;
      process.stdout.write(TTY_MODE_RESET);
    };

    const restore = () => {
      resetModes();
      try { if (stdin.isTTY) stdin.setRawMode(wasRaw); } catch {}
      stdin.pause();
      stdin.removeListener("data", onInput);
      process.stdout.removeListener("resize", onResize);
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      restore();
      try { socket.close(); } catch {}
      resolve(code);
    };

    const send = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };

    const onInput = (data: Buffer) => {
      // Ctrl-\ (0x1c) twice in a row detaches, leaving the daemon session alive.
      if (data.length === 1 && data[0] === 0x1c) {
        const now = Date.now();
        if (now - detachArmed < 1500) {
          resetModes();
          process.stdout.write(c.dim("\r\n[detached — session still running; `bivy resume` to return]\r\n"));
          finish(0);
          return;
        }
        detachArmed = now;
        return;
      }
      const text = inputDecoder.write(data);
      if (termId && text) send({ kind: "terminal.input", termId, data: text });
    };

    const onResize = () => {
      if (!termId) return;
      const { cols, rows } = termSize();
      send({ kind: "terminal.resize", termId, cols, rows });
    };

    const beginTty = () => {
      if (bound) return;
      bound = true;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onInput);
      process.stdout.on("resize", onResize);
    };

    socket.on("open", () => open(socket));
    socket.on("error", (err) => {
      process.stderr.write(c.red(`\r\nConnection error: ${err instanceof Error ? err.message : String(err)}\r\n`));
      finish(1);
    });
    socket.on("close", () => finish(settled ? 0 : 1));
    socket.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const type = msg.type;
      if (type === "terminal.opened" && !termId) {
        termId = String(msg.termId);
        beginTty();
        onResize();
      } else if (type === "terminal.attached" && (!termId || msg.termId === termId)) {
        termId = String(msg.termId);
        if (typeof msg.data === "string") process.stdout.write(msg.data);
        beginTty();
        onResize();
      } else if (type === "terminal.gone" && msg.termId === termId) {
        resetModes();
        process.stderr.write(c.red(`\r\nTerminal ${termId} is no longer running.\r\n`));
        finish(1);
      } else if (type === "terminal.output" && msg.termId === termId) {
        if (typeof msg.data === "string") process.stdout.write(msg.data);
      } else if ((type === "terminal.exit" || type === "terminal.closed") && msg.termId === termId) {
        const code = typeof msg.code === "number" ? msg.code : 0;
        resetModes();
        process.stdout.write(c.dim(`\r\n[session ended]\r\n`));
        finish(code);
      } else if (type === "terminal.error") {
        process.stderr.write(c.red(`\r\n${String(msg.error || "Terminal error")}\r\n`));
        if (!bound) finish(1);
      }
    });
  });
}

/**
 * Start a run-terminal on the daemon and return immediately, WITHOUT binding the
 * local TTY. The PTY is daemon-owned, so it keeps running once this client
 * disconnects — the same lifecycle as a Ctrl-\ Ctrl-\ detach, except the
 * terminal was never attached in the first place. Resolves once the daemon
 * confirms the terminal is open (or errors trying).
 */
function openDetached(args: Args, spec: RunSpec, cols: number, rows: number): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl(args.url, args.token));
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      resolve(code);
    };
    socket.on("open", () =>
      socket.send(JSON.stringify({ kind: "terminal.open.run", agent: spec.agent, label: spec.label, name: spec.name, model: spec.model, command: spec.command, args: spec.args ?? [], workspace: spec.workspace, sessionId: spec.sessionId, cols, rows })),
    );
    socket.on("error", (err) => {
      process.stderr.write(c.red(`Connection error: ${err instanceof Error ? err.message : String(err)}\n`));
      finish(1);
    });
    socket.on("close", () => finish(settled ? 0 : 1));
    socket.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "terminal.opened") {
        const label = spec.name || spec.label || spec.agent || spec.command;
        process.stdout.write(c.green(`Started ${label} in the background.\n`));
        process.stdout.write(c.dim("It keeps running — reopen it in the Bivy app, or with `bivy resume`.\n"));
        finish(0);
      } else if (msg.type === "terminal.error") {
        process.stderr.write(c.red(`${String(msg.error || "Terminal error")}\n`));
        finish(1);
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "run") {
    const spec = args.run!;
    const { cols, rows } = termSize();
    if (args.noFollow) {
      process.exit(await openDetached(args, spec, cols, rows));
    }
    process.stdout.write(c.dim(`Starting ${c.cyan(spec.name || spec.label || spec.agent || spec.command)} — Ctrl-\\ Ctrl-\\ to detach\r\n`));
    const code = await bridge(args, (ws) =>
      ws.send(JSON.stringify({ kind: "terminal.open.run", agent: spec.agent, label: spec.label, name: spec.name, model: spec.model, command: spec.command, args: spec.args ?? [], workspace: spec.workspace, sessionId: spec.sessionId, cols, rows })),
    );
    process.exit(code);
  }

  // attach
  if (!args.termId) {
    process.stderr.write(c.dim("Nothing to attach to. Start one with `bivy run <agent>`, or pick one with `bivy resume`.\n"));
    process.exit(1);
  }
  await attachById(args, args.termId!);
}

// Bind the local TTY to an existing run-terminal by id (replays scrollback).
async function attachById(args: Args, termId: string) {
  const { cols, rows } = termSize();
  process.stdout.write(c.dim(`Attaching to ${c.cyan(termId)} — Ctrl-\\ Ctrl-\\ to detach\r\n`));
  const code = await bridge({ ...args, termId }, (ws) =>
    ws.send(JSON.stringify({ kind: "terminal.attach", termId, cols, rows })),
  );
  process.exit(code);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
