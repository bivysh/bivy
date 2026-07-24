// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, spawnSync } from "node:child_process";

/**
 * Best-effort guess at whether this machine can actually open a browser.
 * macOS and Windows always can; a Linux box needs a display server *and* an
 * opener (`xdg-open`) — a headless server (the common case for a Bivy node)
 * has neither, so callers should print instructions/URLs instead of silently
 * spawning an opener that can't do anything.
 *
 * Mirrors the equivalent check in bin/bivy.mjs (kept separate since the CLI
 * entrypoint doesn't import from src/).
 */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (!hasDisplay) return false;
  const check = spawnSync("sh", ["-lc", 'command -v -- xdg-open >/dev/null 2>&1']);
  return check.status === 0;
}

/**
 * Best-effort open a URL in the local browser. Returns false (and never
 * spawns anything) when canOpenBrowser() is false, so a headless server never
 * wastes a process trying to open a browser that isn't there — callers should
 * print the URL regardless of the return value so the user can open it
 * themselves (on this machine or any other device).
 */
export function openBrowser(target: string): boolean {
  if (!canOpenBrowser()) return false;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // spawn reports a missing opener asynchronously via an 'error' event, not a
    // synchronous throw — without a listener that becomes an unhandled error
    // that crashes the process (see the crash this guarded against previously:
    // canOpenBrowser() already filters out the common "no opener" case, but a
    // race — the opener disappearing between the check and the spawn — is
    // still possible). The URL is also printed by the caller either way.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
