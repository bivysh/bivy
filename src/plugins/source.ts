// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Where a plugin, kit or skill is installed from. A folder or file as-is; a git
 * URL or `github:owner/repo[/path][#ref]` is cloned (shallow) into a temporary
 * folder first, so sharing one is sharing a repository.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GITHUB_RE = /^github:([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)(?:#([\w./-]+))?$/;
const GIT_RE = /^(https:\/\/|git@)[^\s]+?(?:#([\w./-]+))?$/;

export function isRemoteSource(input: string): boolean {
  const git = GIT_RE.exec(input);
  return GITHUB_RE.test(input) || Boolean(git && (input.endsWith(".git") || input.includes(".git#") || input.startsWith("git@") || /^https:\/\/(github|gitlab)\.com\//.test(input)));
}

export function resolveSource(input: string): { path: string; cleanup: () => void } {
  if (!isRemoteSource(input)) return { path: input, cleanup: () => {} };
  const github = GITHUB_RE.exec(input);
  const git = GIT_RE.exec(input);
  const url = github ? `https://github.com/${github[1]}/${github[2]}.git` : input.replace(/#.*$/, "");
  const ref = github ? github[4] : git?.[2];
  const sub = github?.[3]?.replace(/^\//, "") ?? "";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-plugin-src-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, temp], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    const detail = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`Could not clone ${url}${detail ? `: ${detail}` : ""}`);
  }
  return { path: path.join(temp, sub), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

/**
 * The source of a folder inside `source` (a plugin inside a kit), when that can
 * be written down: a local path, or a `github:` source with a sub-path. Other
 * git URLs cannot name a folder, so they return undefined.
 */
export function childSource(source: string, folder: string): string | undefined {
  const github = GITHUB_RE.exec(source);
  if (github) return `github:${github[1]}/${github[2]}${github[3] ?? ""}/${folder.replace(/^\/+|\/+$/g, "")}${github[4] ? `#${github[4]}` : ""}`;
  if (isRemoteSource(source)) return undefined;
  return path.resolve(source, folder);
}

/** The string to record for an install the user named `input`: remote sources as written, folders as absolute paths. */
export function recordableSource(input: string): string {
  return isRemoteSource(input) ? input : path.resolve(input);
}
