// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelAccessProbe } from "./anthropic-preflight.js";

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
