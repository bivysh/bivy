// SPDX-License-Identifier: FSL-1.1-ALv2
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
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

type RunSpec = { agent?: string; label?: string; name?: string; model?: string; command: string; args?: string[]; workspace?: string; sessionId?: string };

type Args = {
  url: string;
  token?: string;
  mode: "run" | "attach";
  run?: RunSpec;
  termId?: string;
};

function parseArgs(argv: string[]): Args {
  let url = process.env.BIVY_URL || `http://localhost:${process.env.PORT || "4317"}`;
  let token = process.env.BIVY_DEVICE_TOKEN || undefined;
  let mode: Args["mode"] = "attach";
  let run: RunSpec | undefined;
  let termId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) url = argv[++i];
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--token" && argv[i + 1]) token = argv[++i];
    else if (arg.startsWith("--token=")) token = arg.slice("--token=".length);
    else if (arg === "--run" && argv[i + 1]) { mode = "run"; run = JSON.parse(argv[++i]); }
    else if (arg === "--attach" && argv[i + 1]) { mode = "attach"; termId = argv[++i]; }
  }
  return { url: url.replace(/\/+$/, ""), token, mode, run, termId };
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

    const restore = () => {
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
        process.stderr.write(c.red(`\r\nTerminal ${termId} is no longer running.\r\n`));
        finish(1);
      } else if (type === "terminal.output" && msg.termId === termId) {
        if (typeof msg.data === "string") process.stdout.write(msg.data);
      } else if ((type === "terminal.exit" || type === "terminal.closed") && msg.termId === termId) {
        const code = typeof msg.code === "number" ? msg.code : 0;
        process.stdout.write(c.dim(`\r\n[session ended]\r\n`));
        finish(code);
      } else if (type === "terminal.error") {
        process.stderr.write(c.red(`\r\n${String(msg.error || "Terminal error")}\r\n`));
        if (!bound) finish(1);
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "run") {
    const spec = args.run!;
    const { cols, rows } = termSize();
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
