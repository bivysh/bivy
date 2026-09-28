// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

/** Resolve without a shell or a lifetime cache: installs, removals and PATH
 * changes must be visible to a running daemon as well as its terminals. */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  if (!command.trim()) return null;
  const win = process.platform === "win32";
  const isExecutable = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, win ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const exts = win ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const withExts = (file: string): string[] =>
    exts.map((ext) => (ext && !file.toLowerCase().endsWith(ext.toLowerCase()) ? file + ext : file));
  const explicit = command.includes("/") || (win && command.includes("\\"));
  const bases = explicit
    ? [path.resolve(cwd, command)]
    : (env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(cwd, dir, command));
  for (const base of bases) {
    for (const candidate of withExts(base)) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
