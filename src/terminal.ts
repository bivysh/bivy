// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as pty from "node-pty";
import { depCacheEnv } from "./harness/dep-cache.js";

/**
 * Terminal sessions — the "jump in and take over" escape hatch.
 *
 * A long-lived PTY (real shell) per terminal, confined to a workspace directory.
 * Output is streamed RAW (ANSI preserved) to whichever client opened it; this is
 * deliberately *not* the ANSI-stripped one-shot command runner in server.ts.
 *
 * This module is transport-agnostic: the caller supplies `onData`/`onExit` sinks,
 * so the same manager serves the local WebSocket (per-socket routing) and the
 * relay (termId-tagged events the client filters). See docs/product-definition.md
 * (chat ⇄ terminal) and docs/DEVELOPMENT_PLAN.md (Phase B).
 */

/**
 * Descriptive metadata attached to a terminal so it can be listed and attached
 * to by clients other than the one that opened it (the phone, another terminal).
 * Used by `bivy run` run-terminals (reattached via `bivy resume` / the app);
 * ordinary shell terminals leave it undefined.
 */
export interface TerminalMeta {
  /** "run" for an agent launched by `bivy run`; undefined for a plain shell. */
  kind?: "run" | "shell" | "tui";
  /** Agent id (e.g. "claude") when this terminal runs a native agent. */
  agent?: string;
  /**
   * Model the agent was asked to run (e.g. "opus"), when set via
   * `bivy run --model`. Best-effort display metadata — a raw PTY can't be
   * introspected, so this reflects what we launched the agent with.
   */
  model?: string;
  /** Human label (e.g. "Claude Code"). */
  label?: string;
  /**
   * A user-facing session name for this run-terminal, distinguishing several
   * live sessions of the same agent (e.g. two `bivy run claude` in different
   * repos). Set via `bivy run --name`, or defaulted from the agent + workspace
   * so lists stay readable. Clients prefer this over `label` as the title.
   */
  name?: string;
  /** True when `name` is only Bivy's launch-time agent/workspace fallback. */
  autoName?: boolean;
  /** The command line launched, for display. */
  command?: string;
  /**
   * For a run-terminal that attaches to an external multiplexer session, the
   * target tag (e.g. "tmux:work"). Lets clients dedupe: reuse the existing
   * attach terminal instead of spawning a second `tmux attach` for the same
   * session.
   */
  mux?: string;
  /**
   * The agent session id pinned at launch (e.g. `claude --session-id <uuid>`),
   * when a `bivy run`/shim launch fixed one. It anchors a later "continue as
   * chat" takeover: the on-disk session to resume, paired with this terminal's
   * PTY pid as the kill target.
   */
  sessionId?: string;
}

export interface TerminalOpenOptions {
  workspace: string;
  cols?: number;
  rows?: number;
  /**
   * Stable id of the client that opened this terminal. Registers the opener's
   * initial dimensions as its per-client size so the shared PTY is sized to the
   * minimum across every attached client (see `setClientSize`). Without it, a
   * later, differently-sized client could resize the PTY out from under the
   * opener and reflow its TUI.
   */
  clientId?: string;
  env?: Record<string, string>;
  /**
   * Program to run instead of the login shell (with `args`). Used to launch an
   * agent's interactive TUI in the workspace; defaults to the user's shell.
   */
  command?: string;
  args?: string[];
  meta?: TerminalMeta;
  onData: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
  /**
   * Fired when the PTY emits an ASCII BEL (`\x07`) — a program rang the terminal
   * bell (a finished build, `echo -e '\a'`, a shell that wants attention). The
   * caller decides whether to escalate it to a push notification so a user who
   * stepped away from the mobile/PWA terminal gets called back. Coalesced to at
   * most one call per output batch so a bell-storm doesn't fan out. Gating (are
   * they actively typing? cooldown) is the caller's job, using `lastInput()`.
   */
  onBell?: () => void;
}

/** A listable summary of a live terminal (for `terminal.list` / GET /api/terminals). */
export interface TerminalSummary {
  id: string;
  workspace: string;
  createdAt: number;
  /**
   * Epoch ms of the most recent PTY output. Lets the cockpit show whether an
   * agent is actively working or idle/waiting — the groundwork for run-terminal
   * status cards. Starts equal to `createdAt`.
   */
  lastActivityAt: number;
  meta: TerminalMeta;
}

interface TerminalEntry {
  proc: pty.IPty;
  workspace: string;
  createdAt: number;
  lastActivityAt: number;
  /**
   * Epoch ms of the most recent client input (keystroke/paste) written to this
   * PTY. Lets a caller distinguish "the user is sitting here typing" from "a bell
   * rang while they were away" — the latter is what warrants a call-me-back push.
   * Starts equal to `createdAt`.
   */
  lastInputAt: number;
  meta: TerminalMeta;
  /**
   * Per-client requested dimensions, keyed by a stable client id. A shared PTY
   * has a single (cols, rows); when several clients attach at different window
   * sizes we size the PTY to the *minimum* over this map (tmux-style) so no
   * client's TUI is ever reflowed wider than its viewport. Entries are added on
   * attach/resize and removed on detach, after which the PTY grows back to the
   * min of whoever remains.
   */
  clientSizes: Map<string, { cols: number; rows: number }>;
  /** Rolling tail of raw (ANSI-preserved) output, replayed to reattaching clients. */
  buffer: string;
  /** Output accumulated since the last coalesced flush (see OUTPUT_FLUSH_MS). */
  pending: string;
  /** Pending flush timer, or null when nothing is queued. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Set once the terminal is torn down (via close() or a natural exit). Makes
   * any late PTY callback inert: killing a PTY can emit one final data chunk
   * *after* close() removed the terminal, and delivering that (or flushing it on
   * the subsequent exit) would fire onData for a terminal the client already
   * tore down — the exact thing close() promises never to do.
   */
  closed: boolean;
  /** Deliver a coalesced batch of output to the client. */
  onData: (data: string) => void;
}

/**
 * Coalescing window (ms) for PTY output. node-pty delivers a chatty program's
 * output (build logs, `cat` of a large file, an agent streaming tokens) as a
 * flurry of small chunks across many event-loop ticks. Emitting one transport
 * frame per chunk floods the WebSocket and — over the relay — pays a per-frame
 * encrypt/chunk cost each time, which is a large part of why the terminal feels
 * laggy under load. Batching a few ms of output into a single frame collapses
 * that by an order of magnitude while adding latency well below the threshold of
 * perception for interactive echo.
 */
// 16ms keeps a single chatty TUI under the relay's default node message budget
// (6000/min ≈ 10ms/frame). At 8ms a fullscreen redraw stream could exceed that
// and the relay closed the socket with "Rate limit exceeded" the moment a
// phone/app attached to a live `bivy run` terminal.
const OUTPUT_FLUSH_MS = 16;

/**
 * How much recent output to retain per terminal for scrollback replay on
 * reconnect. A phone that backgrounds the PWA (or drops its network) reattaches
 * to the still-live shell and gets this tail rewritten so it doesn't come back
 * to a blank screen. Kept modest so a chatty build log can't grow memory without
 * bound.
 */
const SCROLLBACK_LIMIT = 256 * 1024;

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

/**
 * Resolve `command` to a runnable executable path, mirroring how the PTY's exec
 * would search `env`'s PATH. Returns the absolute path, or null when the command
 * can't be found / isn't executable.
 *
 * This exists because node-pty does NOT throw when the target can't be exec'd:
 * its spawn helper prints the cryptic "posix_spawnp failed." into the terminal
 * and exits, so a mistyped or uninstalled agent (e.g. `bivy run claude` with no
 * `claude` on the daemon's PATH) surfaces that message instead of a real error.
 * Resolving up front lets open() throw a clear, catchable error — and hands the
 * PTY an unambiguous absolute path.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const win = process.platform === "win32";
  const isExecutable = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (win) return true;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // On Windows a bare name may need a PATHEXT suffix (claude → claude.cmd).
  const exts = win ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const withExts = (file: string): string[] =>
    exts.map((ext) => (ext && !file.toLowerCase().endsWith(ext.toLowerCase()) ? file + ext : file));

  // A command with an explicit path is resolved directly (against the workspace
  // for a relative one), never via PATH — same as exec.
  if (command.includes("/") || (win && command.includes("\\"))) {
    for (const candidate of withExts(path.resolve(cwd, command))) {
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const candidate of withExts(path.join(dir, command))) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Restore the execute bit on node-pty's bundled `spawn-helper` binary.
 *
 * On macOS/Linux, node-pty launches every PTY by exec'ing this helper. Its
 * prebuilds ship without the execute bit (mode 0664), and a fresh `npm install`
 * — exactly what `bivy update` runs — resets the bit. node-pty does not surface
 * this: its spawn prints the cryptic "posix_spawnp failed." into the terminal and
 * exits, so `bivy run <agent>` dies before the agent starts and keeps breaking
 * after every update until someone runs `chmod +x` by hand.
 *
 * Fix it once, up front, so runs survive updates and reinstalls automatically.
 * Best-effort and idempotent: if node-pty can't be resolved or the helper is
 * already executable, this is a no-op and node-pty reports its own errors.
 */
let spawnHelperEnsured = false;
function ensureSpawnHelperExecutable(): void {
  if (spawnHelperEnsured) return;
  spawnHelperEnsured = true;
  if (process.platform === "win32") return; // Windows has no spawn-helper.

  const makeExecutable = (file: string): void => {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || (st.mode & 0o111) !== 0) return; // missing or already +x
      fs.chmodSync(file, st.mode | 0o755);
    } catch {
      // Missing candidate or read-only install — best-effort.
    }
  };

  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve("node-pty/package.json"));
    // Cover both a from-source build and the prebuilt binaries node-pty ships.
    makeExecutable(path.join(root, "build", "Release", "spawn-helper"));
    const prebuilds = path.join(root, "prebuilds");
    try {
      for (const dir of fs.readdirSync(prebuilds)) {
        makeExecutable(path.join(prebuilds, dir, "spawn-helper"));
      }
    } catch {
      // No prebuilds directory — fine.
    }
  } catch {
    // Couldn't resolve node-pty; leave it to node-pty to report.
  }
}

export class TerminalManager {
  private terminals = new Map<string, TerminalEntry>();

  /** The number of live terminals (for tests / capacity reporting). */
  get size(): number {
    return this.terminals.size;
  }

  open(options: TerminalOpenOptions): string {
    const id = `term-${randomUUID()}`;
    const shell = options.command || defaultShell();
    const shellArgs = options.command ? (options.args ?? []) : [];
    // Ensure a UTF-8 locale so TUIs (e.g. Claude Code) render box-drawing and
    // emoji instead of "?". The daemon may be started by launchd/systemd with no
    // LANG/LC_* in its environment; without a UTF-8 locale the child runs under
    // the C/POSIX locale and downgrades all non-ASCII output. Only fill the gap
    // when no locale is configured — a real locale in the environment still wins.
    const hasLocale = Boolean(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG);
    const localeDefaults = hasLocale ? {} : { LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8" };
    const env = {
      ...localeDefaults,
      ...process.env,
      ...depCacheEnv(options.workspace),
      ...options.env,
      TERM: "xterm-256color",
      // Make it obvious in the shell that this is a Bivy terminal.
      BIVY_TERMINAL: "1",
    } as Record<string, string>;

    // node-pty won't throw for an unresolvable command — it prints
    // "posix_spawnp failed." into the PTY and exits. Resolve up front so we can
    // raise a real error (which callers turn into a `terminal.error`) instead.
    const resolved = resolveExecutable(shell, env, options.workspace);
    if (!resolved) {
      throw new Error(
        options.command
          ? `Cannot run "${shell}": command not found or not executable on the node's PATH. Install it, or check the command.`
          : `Cannot start a terminal: no usable shell found (tried "${shell}"). Set the SHELL environment variable.`,
      );
    }

    // node-pty exec's a bundled `spawn-helper` whose execute bit a fresh install
    // (e.g. `bivy update`) strips — restore it before spawning or this fails with
    // "posix_spawnp failed." See ensureSpawnHelperExecutable().
    ensureSpawnHelperExecutable();

    const proc = pty.spawn(resolved, shellArgs, {
      name: "xterm-256color",
      cols: clampDim(options.cols, 80),
      rows: clampDim(options.rows, 24),
      cwd: options.workspace,
      env,
    });

    const now = Date.now();
    const entry: TerminalEntry = {
      proc,
      workspace: options.workspace,
      createdAt: now,
      lastActivityAt: now,
      lastInputAt: now,
      meta: options.meta ?? {},
      clientSizes: new Map(),
      buffer: "",
      pending: "",
      flushTimer: null,
      closed: false,
      onData: options.onData,
    };
    // Register the opener as a sized client so a later, smaller client shrinks
    // the PTY to the min of the two rather than clobbering the opener's size.
    if (options.clientId) {
      entry.clientSizes.set(options.clientId, {
        cols: clampDim(options.cols, 80),
        rows: clampDim(options.rows, 24),
      });
    }
    this.terminals.set(id, entry);

    const flush = () => {
      entry.flushTimer = null;
      if (entry.closed || !entry.pending) return;
      const batch = entry.pending;
      entry.pending = "";
      entry.onData(batch);
    };

    proc.onData((data) => {
      // A killed PTY can still emit a final chunk after close() tore the
      // terminal down; ignore it so we never deliver output for a closed one.
      if (entry.closed) return;
      // Scrollback tail is kept raw and up to date immediately so a reattach
      // replay never lags the coalesced client stream.
      entry.buffer += data;
      if (entry.buffer.length > SCROLLBACK_LIMIT) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - SCROLLBACK_LIMIT);
      }
      entry.lastActivityAt = Date.now();
      // A BEL in the raw stream means a program rang the terminal bell. Notify the
      // caller once per chunk (a bell-storm within one node-pty chunk collapses to
      // one signal); finer gating is the caller's responsibility.
      if (options.onBell && data.includes("\x07")) {
        try {
          options.onBell();
        } catch {
          /* a bell handler must never break output delivery */
        }
      }
      // Coalesce delivery: accumulate and flush on a short timer instead of
      // emitting a frame per chunk.
      entry.pending += data;
      if (!entry.flushTimer) entry.flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS);
    });
    proc.onExit(({ exitCode, signal }) => {
      // Deliver whatever was buffered before signalling exit, so a program's
      // final output isn't dropped by the coalescing window.
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
      }
      // On a natural exit `closed` is still false, so this delivers the final
      // output. If close() already ran, `closed` is true and flush() is a no-op
      // — we don't re-emit output for a terminal the client tore down.
      flush();
      entry.closed = true;
      this.terminals.delete(id);
      options.onExit(exitCode, signal);
    });

    return id;
  }

  write(id: string, data: string): boolean {
    const entry = this.terminals.get(id);
    if (!entry) return false;
    entry.lastInputAt = Date.now();
    entry.proc.write(data);
    return true;
  }

  /**
   * Record `clientId`'s desired size for terminal `id` and re-size the shared
   * PTY to the minimum over all currently-attached clients. Called on both
   * attach and resize. Using the min (rather than "last writer wins") means a
   * second client attaching at a different window size can never reflow another
   * client's TUI wider than its viewport — it only ever adds unused margin on
   * the larger client, tmux-style.
   */
  setClientSize(id: string, clientId: string, cols: number, rows: number): boolean {
    const entry = this.terminals.get(id);
    if (!entry) return false;
    entry.clientSizes.set(clientId, { cols: clampDim(cols, 80), rows: clampDim(rows, 24) });
    this.applyMinSize(entry);
    return true;
  }

  /**
   * Forget `clientId`'s size for terminal `id` (it detached from this terminal)
   * and re-size the PTY to the min of whoever remains, so the surviving clients
   * grow back to their real dimensions. No-op if the client had no size here.
   */
  dropClientSize(id: string, clientId: string): boolean {
    const entry = this.terminals.get(id);
    if (!entry) return false;
    if (entry.clientSizes.delete(clientId)) this.applyMinSize(entry);
    return true;
  }

  /**
   * Forget `clientId` across every terminal — called when a client's transport
   * (socket/relay) drops, so terminals it viewed grow back for the clients that
   * remain. A disconnecting client may have sized terminals it never `owned`
   * (e.g. shared run-terminals), so this sweeps all of them.
   */
  dropClient(clientId: string): void {
    for (const entry of this.terminals.values()) {
      if (entry.clientSizes.delete(clientId)) this.applyMinSize(entry);
    }
  }

  /** Size the PTY to the min cols/rows over all attached clients. */
  private applyMinSize(entry: TerminalEntry): void {
    // No sized clients (nobody attached, or an unsized opener): leave the PTY at
    // its current size rather than snapping to the 80x24 clamp floor.
    if (entry.clientSizes.size === 0) return;
    let cols = Infinity;
    let rows = Infinity;
    for (const size of entry.clientSizes.values()) {
      if (size.cols < cols) cols = size.cols;
      if (size.rows < rows) rows = size.rows;
    }
    try {
      entry.proc.resize(clampDim(cols, 80), clampDim(rows, 24));
    } catch {
      // resizing a dying pty can throw — harmless
    }
  }

  close(id: string): boolean {
    const entry = this.terminals.get(id);
    if (!entry) return false;
    this.terminals.delete(id);
    // Drop any queued output — the client asked to close, so don't emit a
    // trailing batch (which would fire onData for a terminal it has torn down).
    // `closed` also neutralises the final PTY chunk a kill can emit afterwards.
    entry.closed = true;
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    entry.pending = "";
    try {
      entry.proc.kill();
    } catch {
      // already gone
    }
    return true;
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /** Metadata for a live terminal, or null if the id is unknown. */
  meta(id: string): TerminalMeta | null {
    const entry = this.terminals.get(id);
    return entry ? entry.meta : null;
  }

  /** Epoch ms of the last PTY output for a live terminal, or null if unknown. */
  lastActivity(id: string): number | null {
    const entry = this.terminals.get(id);
    return entry ? entry.lastActivityAt : null;
  }

  /** Epoch ms of the last client input to a live terminal, or null if unknown. */
  lastInput(id: string): number | null {
    const entry = this.terminals.get(id);
    return entry ? entry.lastInputAt : null;
  }

  /**
   * Listable summaries of live terminals, newest first. `filter` narrows to a
   * kind (e.g. only `bivy run` terminals) so a plain shell a client opened for
   * itself doesn't show up as an attachable agent session.
   */
  list(filter?: (meta: TerminalMeta) => boolean): TerminalSummary[] {
    const out: TerminalSummary[] = [];
    for (const [id, entry] of this.terminals) {
      if (filter && !filter(entry.meta)) continue;
      out.push({ id, workspace: entry.workspace, createdAt: entry.createdAt, lastActivityAt: entry.lastActivityAt, meta: entry.meta });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * The retained scrollback tail for a live terminal, or null if the id is
   * unknown (never opened, or already exited). Callers replay this to a client
   * that is reattaching to an existing shell.
   */
  snapshot(id: string): string | null {
    const entry = this.terminals.get(id);
    return entry ? entry.buffer : null;
  }

  /**
   * The OS process id of a terminal's PTY child, or undefined if the id is
   * unknown. Used to register a reliable kill target for a pinned agent run, so a
   * later "continue as chat" takeover can stop the exact process it launched
   * instead of searching for it.
   */
  pid(id: string): number | undefined {
    const entry = this.terminals.get(id);
    return entry ? entry.proc.pid : undefined;
  }

  /** Kill every terminal (process shutdown). */
  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }
}

function clampDim(value: number | undefined, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1), 1000);
}
