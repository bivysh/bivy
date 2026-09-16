// SPDX-License-Identifier: AGPL-3.0-only
import { BIVY_PROVIDER_CATALOG, bivyProvider } from "./provider-catalog.js";
import type { ModelInfo } from "./store.js";

/** A credential-backed preview, not a claim that a future runtime supports a model.
 * No secrets or node-local credentials belong in this catalog. The destination
 * validates the selection before the preserved first prompt is delivered.
 */
export function launchModels(providers: readonly string[], discovered: readonly ModelInfo[] = []): ModelInfo[] {
  const available = new Set(providers.map(id => bivyProvider(id)?.id ?? id));
  const models = new Map<string, ModelInfo>();
  for (const provider of BIVY_PROVIDER_CATALOG) {
    if (!available.has(provider.id)) continue;
    for (const model of provider.models) {
      models.set(`${provider.id}\0${model.id}`, { ...model, label: model.name, provider: provider.id, configured: true });
    }
  }
  // Prefer richer runtime metadata (including custom endpoints) where known,
  // but never inherit the connected machine's authentication flags.
  for (const model of discovered) {
    const provider = String(model.provider ?? "");
    if (!available.has(bivyProvider(provider)?.id ?? provider) || !model.id || model.id === "unknown" || model.modelCount != null) continue;
    models.set(`${provider}\0${model.id}`, { ...model, configured: true, current: false });
  }
  return [...models.values()];
}

/**
 * Why a launch's saved model can't be selected on the destination machine.
 * A catalog that lacks the whole provider means its credential never reached
 * the machine — a very different fix from a catalog that has the provider but
 * not this model id, so say which one it is instead of a generic shrug.
 */
export function launchModelUnavailableError(requested: { id: string; provider: string }, models: readonly ModelInfo[], managed: boolean): string {
  if (models.some(model => model.provider === requested.provider)) {
    return "Your saved model isn't available on this machine. Choose another model.";
  }
  return managed
    ? `Your saved model isn't available on this machine — its ${requested.provider} credential didn't reach Bivy Cloud. Check its unattended-runs grant in Settings → Models & keys (with a machine online), then refresh, or choose another model.`
    : `Your saved model isn't available on this machine — no ${requested.provider} credential is connected here. Connect ${requested.provider} on this machine, then refresh, or choose another model.`;
}
