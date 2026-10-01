// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelAccessProbe } from "./anthropic-preflight.js";
import type { NativeAuthAgent } from "./native-auth-import.js";

/** Use the same configured providers as the model picker, including environment
 * credentials. An unrelated rejected key must not hide a usable provider. */
export async function credentialReadiness(
  providers: readonly { id: string; configured: boolean }[],
  probe: (provider: string) => Promise<ModelAccessProbe>,
) {
  const configured = providers.filter((provider) => provider.configured);
  const results = await Promise.all(configured.map((provider) => probe(provider.id)));
  const usable = results.find((result) => result.ok);
  const result = usable ?? results[0];
  return {
    configured: configured.length > 0,
    providers: configured.map((provider) => provider.id),
    probed: result?.probed ?? false,
    ok: Boolean(usable),
    ...(result?.reason ? { reason: result.reason } : {}),
  };
}

export type VaultReadiness = Awaited<ReturnType<typeof credentialReadiness>>;

/** Where an agent's model login lives. "vault": Bivy's credential vault (the
 *  node runs Pi on it). A native source: the agent's own login, which
 *  discoverNativeAuth can find. Agents not listed own a login Bivy can't see. */
const LOGIN_SOURCE: Record<string, "vault" | NativeAuthAgent> = {
  pi: "vault",
  "claude-code-sdk": "claude",
  "codex-approvals": "codex",
  grok: "grok",
};

/** The first-run credential check for the node's default agent. A usable vault
 *  credential always counts. Otherwise a vault agent needs one, a found native
 *  login passes, and anything Bivy can't see is unknown, never failed: Claude
 *  Code on macOS keeps its login in the Keychain, and agents read env keys. */
export function agentCredentialReadiness(
  agent: string | undefined,
  vault: VaultReadiness,
  nativeLoginFound: (source: NativeAuthAgent) => boolean,
) {
  const source = (agent && LOGIN_SOURCE[agent]) || undefined;
  if (vault.ok || source === "vault") return { ...vault, login: "vault" as const };
  if (source && nativeLoginFound(source)) return { ...vault, probed: false, ok: true, login: "agent" as const };
  return { ...vault, probed: false, ok: true, login: "unknown" as const };
}
