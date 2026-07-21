// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";

/**
 * The device-code / callback-url step of an in-flight OAuth login
 * (`state.oauth`). Shared by the Settings "Keys & OAuth" panel and the model
 * picker's inline connect flow — both just need to show whichever "waiting
 * for the node" or "paste this code back" step the current provider's login
 * is on, driven purely by `controller.store`'s live `oauth` state.
 */
export function OauthStep() {
  const oauth = controller.store.getState().oauth;
  const [code, setCode] = useState("");
  if (!oauth) return null;
  const url = oauth.authUrl || oauth.deviceCode?.verificationUri;
  const needsPaste = !oauth.deviceCode && !oauth.usesCallbackServer;
  return (
    <div className="settings-form">
      {oauth.error && <div className="banner error inline">{oauth.error}</div>}
      {url && (
        <a className="btn primary block" href={url} target="_blank" rel="noopener">
          Open sign-in page
        </a>
      )}
      {oauth.deviceCode?.userCode && (
        <p className="muted">
          Code: <strong>{oauth.deviceCode.userCode}</strong>
        </p>
      )}
      {needsPaste ? (
        <>
          <label className="field-label">Paste the code from the sign-in page</label>
          <input className="picker-search" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn primary" disabled={!code.trim()} onClick={() => controller.submitOauthCode(oauth.id, code.trim())}>
            Submit
          </button>
        </>
      ) : (
        <p className="muted">{oauth.status || "Waiting for sign-in…"}</p>
      )}
    </div>
  );
}

/**
 * Minimal "connect this provider" form: an OAuth sign-in button (when the
 * provider supports it) plus an API-key input. Used inline by the model
 * picker (#390) so picking an unconnected model's "Connect" action doesn't
 * have to leave the picker and navigate to Settings. Deliberately smaller
 * than Settings' ProvidersPanel detail view (no reset/remove — that stays a
 * Settings-only action) since here the only goal is getting the model
 * selectable, not managing the credential long-term.
 */
export function ProviderConnectForm({ state, providerId }: { state: AppState; providerId: string }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const provider = state.providers.find((p) => p.id === providerId);
  const name = provider?.name || providerId;

  if (provider?.configured) {
    // A "Connect" tap can race a connection that already landed (e.g. the
    // providers.list refresh from a previous save beat this mount) — reflect
    // that instead of showing a redundant sign-in form.
    return (
      <div className="settings-form">
        <p className="muted">{name} is already connected.</p>
      </div>
    );
  }

  if (state.oauth && state.oauth.provider === providerId) {
    return <OauthStep />;
  }

  return (
    <div className="settings-form">
      {provider?.oauth && (
        <button className="btn primary block" onClick={() => controller.startOauth(providerId)}>
          Sign in with {name}
        </button>
      )}
      <label className="field-label">API key</label>
      <input
        className="picker-search"
        type="password"
        value={key}
        placeholder="Paste API key"
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="row-actions">
        <button
          className="btn primary"
          disabled={!key.trim() || busy}
          onClick={() => {
            setBusy(true);
            controller.saveApiKey(providerId, key.trim());
            setKey("");
            // provider.apiKey has no direct ack — re-list so `provider.configured`
            // above (and the model picker's own providers watch) reflect the
            // node's real outcome instead of a blind timer either way.
            setTimeout(() => {
              controller.listProviders();
              setBusy(false);
            }, 500);
          }}
        >
          Save key
        </button>
      </div>
    </div>
  );
}
