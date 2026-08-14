// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AppState } from "@bivy/core";
import { modelAuthApiKeyProvider } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { ProviderConnectForm } from "./ProviderConnect.js";

/**
 * First-run "sign in to your model" prompt for a freshly-launched ephemeral
 * runner that came online with no model credentials (`state.presentation.needsModelAuth`).
 *
 * This is the one case the vault-sync paths can't cover — a phone-only account
 * whose very first runner has nothing to inherit (no device key, no peer, no
 * hosted escrow). The user signs in once here, over the ordinary
 * `provider.oauth.start` paste-back that runs ON this runner; the node then
 * escrows the login so every future runner inherits it with no prompt.
 *
 * We reuse `ProviderConnectForm` verbatim — it already renders "Sign in with
 * {provider}" plus the manual-code paste step (`OauthStep`) and an API-key
 * fallback. The store auto-dismisses this prompt the instant a provider becomes
 * configured (login completed, or a sync landed), so this component just has to
 * render while `needsModelAuth` is set for the current node.
 */
export function FirstRunModelAuthSheet({ state }: { state: AppState }) {
  const req = state.presentation.needsModelAuth;
  // Only show it for the runner it was raised for — a node switch clears it in
  // the store, but guard here too so a stale render can never target the wrong
  // node.
  if (!req || req.nodeId !== state.connection.currentNodeId) return null;
  const provider = state.catalogs.providers.find((p) => p.id === req.provider);
  const name = provider?.name || req.provider;
  // A `reason` means an already-running agent hit an auth failure mid-session
  // (missing/expired credential → 401), not a fresh ephemeral runner. Explain the
  // re-auth rather than the first-run "future runners inherit it" story.
  const reauth = Boolean(req.reason);
  return (
    <Sheet title="Sign in to your model" onClose={() => controller.dismissModelAuthPrompt()}>
      <div className="settings-form">
        <p className="muted settings-intro">
          {reauth
            ? `Your agent couldn't reach ${name} — its credential is missing or expired. Sign in again to keep going.`
            : `This temporary Machine needs a model before it can run your task. Sign in once with ${name}. The credential is encrypted for reuse by future isolated Machines; on Bivy Cloud this optional unattended path uses hosted credential custody.`}
        </p>
        <ProviderConnectForm state={state} providerId={req.provider} apiKeyProvider={modelAuthApiKeyProvider(req.provider)} />
      </div>
    </Sheet>
  );
}
