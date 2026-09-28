// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Launch and stop commands the same way on every OS. Dependency-free so the CLI
 * (bin/bivy.mjs), the daemon and release scripts share one implementation;
 * shipped to dist/ beside the compiled daemon like hosted-endpoints.mjs.
 *
 * On POSIX every function is the identity (or a process-group signal). Windows
 * needs two things plain spawn() does not do:
 *   - PATH lookup with PATHEXT. CreateProcess only appends `.exe`, so `claude`,
 *     `npx` or `codex` — npm installs every CLI as a `.cmd` shim — are ENOENT.
 *   - `.cmd`/`.bat` files run through cmd.exe. Node refuses to do that implicitly
 *     (CVE-2024-27980), so the command line is built and escaped here, following
 *     cross-spawn's rules, instead of passing `shell: true` with raw arguments.
 *     Arguments are escaped for two parses: cmd.exe's, then the batch file's own
 *     line that forwards `%*` (every npm shim, global or node_modules/.bin, does).
 *     One level would let `a"&calc&"` — say, in an agent prompt — run `calc`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/** Resolve without a shell or a lifetime cache: installs, removals and PATH
 * changes must be visible to a running daemon as well as its terminals. */
export function resolveExecutable(command, env = process.env, cwd = process.cwd(), platform = process.platform) {
  if (!command.trim()) return null;
  const win = platform === "win32";
  const isExecutable = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, win ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const exts = win ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  // An explicit extension is tried as-is first (`node.exe`, `tool.cmd`).
  const withExts = (file) => [...(win && path.extname(file) ? [file] : []), ...exts.map((ext) => file + ext)];
  const explicit = command.includes("/") || (win && command.includes("\\"));
  const delimiter = win ? ";" : ":";
  const bases = explicit
    ? [path.resolve(cwd, command)]
    : (envValue(env, "PATH") || "").split(delimiter).filter(Boolean).map((dir) => path.resolve(cwd, dir.replace(/^"(.*)"$/, "$1"), command));
  for (const base of bases) {
    for (const candidate of withExts(base)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

// Windows environment names are case-insensitive (`Path` is the usual spelling).
function envValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg) {
  // Windows argv rules: a backslash run is literal unless a quote follows, so
  // double every run before a quote (then escape the quote) and every trailing
  // run (it precedes our closing quote).
  const quoted = String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * The spawn triple that launches `command args` on `platform`. Options that
 * must accompany it (windowsVerbatimArguments) are returned beside it; merge
 * them into the spawn options. An unresolvable command is returned unchanged so
 * spawn() reports its usual ENOENT.
 */
export function portableCommand(command, args = [], { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  if (platform !== "win32") return { command, args, options: {} };
  const resolved = resolveExecutable(command, env, cwd, platform);
  if (!resolved) return { command, args, options: {} };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, options: {} };
  const line = [path.normalize(resolved).replace(CMD_META, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command: envValue(env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function prepare(command, args, options = {}) {
  const portable = portableCommand(command, args, { env: options.env ?? process.env, cwd: options.cwd ?? process.cwd() });
  // Never flash a console window for a background child of the daemon or CLI.
  return [portable.command, portable.args, { windowsHide: true, ...options, ...portable.options }];
}

/** child_process.spawn with portableCommand applied. */
export function portableSpawn(command, args = [], options = {}) {
  return spawn(...prepare(command, args, options));
}

/** child_process.spawnSync with portableCommand applied. */
export function portableSpawnSync(command, args = [], options = {}) {
  return spawnSync(...prepare(command, args, options));
}

/**
 * Stop `pid` and everything it started. POSIX signals the process group (the
 * child must have been spawned `detached`, making it the group leader), falling
 * back to the process alone. Windows has no groups or signals: a `.cmd` agent
 * runs as cmd.exe → node.exe, so killing the direct child would orphan the real
 * agent. taskkill /T ends the tree; it is always forceful there.
 */
export function killProcessTree(pid, signal = "SIGTERM", platform = process.platform) {
  if (!pid) return false;
  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (result.status === 0) return true;
    try { process.kill(pid); return true; } catch { return false; }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

/** Where `npm install --global --prefix <prefix>` puts executables: Unix
 * `<prefix>/bin`, Windows the prefix itself. */
export function npmPrefixBin(prefix, platform = process.platform) {
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}
