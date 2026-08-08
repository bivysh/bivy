// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Grok (xAI CLI) credential preflight.
//
// The official Grok CLI authenticates one of two ways: an xAI API key read from
// `XAI_API_KEY` / `GROK_API_KEY`, or OIDC tokens in `$GROK_HOME/auth.json`
// (default `~/.grok/auth.json`). Bivy's shared credential vault forwards *API
// keys* to every agent (see credentials.ts), and `grok-auth.ts` mints the
// auth.json from a connected xAI *subscription* — so both sign-in kinds now
// reach Grok.
//
// This preflight is the backstop: if neither an API key nor an auth.json is
// present after that handoff, the CLI fails with an opaque "API key required"
// (vibe-kit) or "Not signed in" (official) message. We detect that up front and
// return a clear, actionable message instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GrokPreflightDeps {
  /** Existence check (injectable for tests). Defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Home directory (injectable for tests). Defaults to os.homedir(). */
  home?: string;
  /** GROK_HOME override (injectable for tests). Defaults to $GROK_HOME. */
  grokHome?: string;
}

/** Path to the Grok CLI's own auth file (`GROK_HOME/auth.json`, default `~/.grok`). */
export function grokAuthFile(deps: GrokPreflightDeps = {}): string {
  const grokHome = (deps.grokHome ?? process.env.GROK_HOME)?.trim();
  const base = grokHome ? grokHome : path.join(deps.home ?? os.homedir(), ".grok");
  return path.join(base, "auth.json");
}

/** The user-facing message shown when Grok has no xAI credential. */
export const GROK_NO_CREDENTIAL_MESSAGE = [
  "Grok has no xAI credential on this node, so it can't start a turn.",
  "",
  "Fix it any of these ways:",
  "• Connect SuperGrok / X Premium under Keys & OAuth — Bivy mints Grok's auth file from it automatically, or",
  "• Add an xAI API key under Keys & OAuth — Bivy passes it as XAI_API_KEY (and GROK_API_KEY), or",
  "• Run `grok login` on this node to sign in directly (official Grok CLI).",
  "",
  "Install the official Grok CLI if you haven't: `curl -fsSL https://x.ai/cli/install.sh | bash`",
  "(The older @vibe-kit/grok-cli package only accepts API keys and cannot use a subscription login.)",
  "",
  "If you already connected the xAI subscription in Bivy and still see this, the saved login could not be projected — reconnect it under Keys & OAuth, or delete a stale ~/.grok/auth.json and try again.",
].join("\n");

/**
 * Returns a human-readable error when the Grok CLI has no usable xAI
 * credential, or undefined when a credential is present so the turn should
 * proceed. `env` is the environment the Grok subprocess will run with (ambient
 * process env + Bivy's vault handoff).
 */
export function grokCredentialPreflight(
  env: Record<string, string | undefined>,
  deps: GrokPreflightDeps = {},
): string | undefined {
  if (env.XAI_API_KEY?.trim() || env.GROK_API_KEY?.trim()) return undefined;
  const exists = deps.fileExists ?? ((p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  // Prefer the GROK_HOME the prepare step may have just pinned on env.
  const homeFromEnv = env.GROK_HOME?.trim();
  if (exists(grokAuthFile({ ...deps, grokHome: homeFromEnv || deps.grokHome }))) return undefined;
  return GROK_NO_CREDENTIAL_MESSAGE;
}
