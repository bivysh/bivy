// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Explicit native-login discovery. Reading never changes the source login.
import fs from "node:fs";
import path from "node:path";
import { claudeCredentialFiles } from "./anthropic-preflight.js";
import { resolveCodexHome } from "./codex-auth.js";
import { resolveGrokHome } from "./grok-auth.js";
import { claudeAuthToCredential, codexAuthToCredential, grokAuthToCredential } from "./credential-ingest.js";
import type { StoredCredential } from "./credential-store.js";

export const nativeAuthSources = {
  claude: { files: claudeCredentialFiles, map: claudeAuthToCredential },
  codex: { files: () => [path.join(resolveCodexHome(), "auth.json")], map: codexAuthToCredential },
  grok: { files: () => [path.join(resolveGrokHome(), "auth.json")], map: grokAuthToCredential },
};
export type NativeAuthAgent = keyof typeof nativeAuthSources;
export type NativeAuthDiscovery =
  | { agent: NativeAuthAgent; provider: string; credential: StoredCredential; status: "found" }
  | { agent: NativeAuthAgent; status: "missing" | "unreadable" | "unsupported" };

export function discoverNativeAuth(agent: NativeAuthAgent): NativeAuthDiscovery {
  const source = nativeAuthSources[agent];
  let status: "missing" | "unreadable" | "unsupported" = "missing";
  for (const file of source.files()) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const mapped = source.map(raw);
      if (mapped) return { agent, status: "found", provider: mapped.providerId, credential: mapped.credential };
      status = "unsupported";
    } catch (error) {
      // Never report raw parse errors: they can contain credential material.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") status = "unreadable";
    }
  }
  return { agent, status };
}
