// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";

/**
 * The device-code / callback-url step of an in-flight OAuth login
 * (`state.presentation.oauth`). Shared by the Settings "Keys & OAuth" panel and the model
 * picker's inline connect flow — both just need to show whichever "waiting
 * for the node" or "paste this code back" step the current provider's login
 * is on, driven purely by `controller.store`'s live `oauth` state.
 */
export function OauthStep() {
  const oauth = controller.store.getState().presentation.oauth;
  const [code, setCode] = useState("");
  const [deviceFallback, setDeviceFallback] = useState(false);
  const [openingOnNode, setOpeningOnNode] = useState(false);
  const [openedOnNode, setOpenedOnNode] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  if (!oauth) return null;
  const url = oauth.authUrl || oauth.deviceCode?.verificationUri;
  const deviceCode = Boolean(oauth.deviceCode);
  const canOpenOnNode = !deviceCode && oauth.canOpenOnNode === true;
  const machine = oauth.nodeName || "your machine";

  const openOnNode = async () => {
    setOpeningOnNode(true);
    setOpenError(null);
    try {
      const result = await controller.openOauthOnNode(oauth.id);
      setOpenedOnNode(result.opened);
      if (!result.opened) {
        setOpenError(result.error || `Could not open a browser on ${machine}.`);
        setDeviceFallback(true);
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
      setDeviceFallback(true);
    } finally {
      setOpeningOnNode(false);
    }
  };

  const useThisDevice = () => {
    setDeviceFallback(true);
    if (url) window.open(url, "_blank", "noopener");
  };

  const pasteClipboard = async () => {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (value) {
        setCode(value);
        controller.submitOauthCode(oauth.id, value);
      }
    } catch {
      setOpenError("Clipboard access was blocked. Paste the redirect URL below instead.");
    }
  };

  return (
    <div className="settings-form">
      {oauth.error && <div className="banner inline" data-tone="danger" role="alert">{oauth.error}</div>}
      {openError && <div className="banner inline" data-tone="danger" role="alert">{openError}</div>}

      {deviceCode && url && <a className="btn primary block" href={url} target="_blank" rel="noopener">Continue on this device</a>}
      {oauth.deviceCode?.userCode && <p className="muted">Code: <strong>{oauth.deviceCode.userCode}</strong></p>}

      {canOpenOnNode && !deviceFallback && <>
        <button className="btn primary block" disabled={openingOnNode || openedOnNode} onClick={() => void openOnNode()}>
          {openingOnNode ? "Opening…" : openedOnNode ? `Opened on ${machine}` : `Open sign-in on ${machine}`}
        </button>
        <p className="muted">The provider will return directly to Bivy on that machine. This page updates automatically.</p>
        {!openedOnNode && <button className="btn link" onClick={useThisDevice}>Use this device instead</button>}
      </>}

      {!deviceCode && (!canOpenOnNode || deviceFallback) && <>
        {!deviceFallback && url && <a className="btn primary block" href={url} target="_blank" rel="noopener">Continue on this device</a>}
        <p className="muted">After approval, the browser may stop on a localhost page. Copy its full URL, return here, then paste it.</p>
        {typeof navigator !== "undefined" && navigator.clipboard && <button className="btn" onClick={() => void pasteClipboard()}>Paste redirect from clipboard</button>}
        <label className="field-label" htmlFor="oauth-redirect-code">Redirect URL or authorization code</label>
        <input id="oauth-redirect-code" className="picker-search" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn primary" disabled={!code.trim()} onClick={() => controller.submitOauthCode(oauth.id, code.trim())}>Submit</button>
      </>}

      <p className="muted" role="status">{oauth.status || "Waiting for sign-in…"}</p>
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
export function ProviderConnectForm({
  state,
  providerId,
  apiKeyProvider,
}: {
  state: AppState;
  providerId: string;
  /** Where a pasted API key is saved, when it differs from the OAuth id — e.g.
   *  Codex signs in as `openai-codex` but its key lives under `openai`
   *  (OPENAI_API_KEY). Defaults to `providerId`. */
  apiKeyProvider?: string;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = state.catalogs.providers.find((p) => p.id === providerId);
  const name = provider?.name || providerId;
  const keyProvider = apiKeyProvider || providerId;

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

  if (state.presentation.oauth && state.presentation.oauth.provider === providerId) {
    return <OauthStep />;
  }

  return (
    <div className="settings-form">
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
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
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // Await the node's authoritative ack. A timer/re-list can make a
              // failed save look successful and is especially harmful in the
              // first-run auth path.
              await controller.setCredential(keyProvider, "default", { key: key.trim() });
              // Keep the account's device vault converged too, so the same item
              // can seed a first machine even when no peer node is online later.
              await controller.setEphemeralModelKey(keyProvider, key.trim(), "account", "default").catch(() => {});
              setKey("");
              controller.listProviders();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save key
        </button>
      </div>
    </div>
  );
}
