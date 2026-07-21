// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Codex credential preflight.
//
// The Codex CLI authenticates one of two ways: an OpenAI API key read from the
// `OPENAI_API_KEY` environment variable, or tokens in `CODEX_HOME/auth.json`
// (default `~/.codex/auth.json`). Bivy's shared credential vault forwards *API
// keys* to every agent (see credentials.ts), and `codex-auth.ts` mints the
// auth.json from a connected ChatGPT/Codex *subscription* — so both sign-in kinds
// now reach Codex.
//
// This preflight is the backstop: if neither an API key nor an auth.json is
// present after that handoff (e.g. no OpenAI sign-in at all, or a saved
// subscription that could not be refreshed), `codex exec` would fail with the
// opaque upstream error `unexpected status 401 Unauthorized: Missing bearer or
// basic authentication in header`. We detect that up front and return a clear,
// actionable message instead of letting the subprocess spawn and die on a 401.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexPreflightDeps {
  /** Existence check (injectable for tests). Defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Home directory (injectable for tests). Defaults to os.homedir(). */
  home?: string;
  /** CODEX_HOME override (injectable for tests). Defaults to $CODEX_HOME. */
  codexHome?: string;
}

/** Path to the Codex CLI's own auth file (`CODEX_HOME/auth.json`, default `~/.codex`). */
export function codexAuthFile(deps: CodexPreflightDeps = {}): string {
  const codexHome = (deps.codexHome ?? process.env.CODEX_HOME)?.trim();
  const base = codexHome ? codexHome : path.join(deps.home ?? os.homedir(), ".codex");
  return path.join(base, "auth.json");
}

/** The user-facing message shown when Codex has no OpenAI credential. */
export const CODEX_NO_CREDENTIAL_MESSAGE = [
  "Codex has no OpenAI credential on this node, so it can't start a turn — it would fail with `401 Unauthorized: Missing bearer or basic authentication in header`.",
  "",
  "Fix it any of these ways:",
  "• Connect ChatGPT Plus/Pro (Codex) under Keys & OAuth — Bivy mints Codex's auth file from it automatically, or",
  "• Add an OpenAI API key under Keys & OAuth — Bivy passes it to Codex as OPENAI_API_KEY, or",
  "• Run `codex login` on this node to sign in directly.",
  "",
  "If you already connected the ChatGPT/Codex subscription in Bivy and still see this, the saved login could not be refreshed — reconnect it under Keys & OAuth.",
].join("\n");

/**
 * Returns a human-readable error when the Codex CLI has no usable OpenAI
 * credential (no `OPENAI_API_KEY` in the resolved environment and no
 * `codex login` auth file), or undefined when a credential is present so the
 * turn should proceed. `env` is the environment the Codex subprocess will run
 * with (ambient process env + Bivy's vault handoff), so this catches both an
 * OpenAI API key stored in Bivy and one already present on the node.
 */
export function codexCredentialPreflight(
  env: Record<string, string | undefined>,
  deps: CodexPreflightDeps = {},
): string | undefined {
  if (env.OPENAI_API_KEY?.trim()) return undefined;
  const exists = deps.fileExists ?? ((p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (exists(codexAuthFile(deps))) return undefined;
  return CODEX_NO_CREDENTIAL_MESSAGE;
}
