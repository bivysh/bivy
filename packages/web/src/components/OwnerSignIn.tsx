// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { controller } from "../store/useStore.js";

/** Deployment-neutral owner setup/sign-in, including installed PWAs. */
export function OwnerSignIn({ setupRequired, passwordConfigured }: { setupRequired: boolean; passwordConfigured: boolean }) {
  const [setup, setSetup] = useState(setupRequired && !passwordConfigured);
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (setup && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const response = await fetch(`/auth/owner/${setup ? "setup" : "login"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, ...(setup ? { setupToken: secret } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not sign in. Please try again.");
      if (typeof data.token !== "string" || !data.token) throw new Error("The server did not return a sign-in token.");
      if (typeof data.relayUrl === "string") controller.local.relay = data.relayUrl;
      setSecret(""); setPassword(""); setConfirmation("");
      controller.completeSignIn(data.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach your server. Try again.");
    } finally { setBusy(false); }
  }
  return (
    <section aria-labelledby="owner-sign-in-heading">
      <h2 id="owner-sign-in-heading">{setup ? "Set up owner access" : "Owner sign-in"}</h2>
      {setup && <p className="muted">Choose a password to sign in without an email provider.</p>}
      <form className="setup-email" onSubmit={submit} aria-busy={busy}>
        {setup && <div className="settings-field">
          <label className="field-label" htmlFor="owner-secret">Setup secret</label>
          <input id="owner-secret" className="field" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} required maxLength={256} disabled={busy} aria-describedby="owner-secret-help" />
          <span className="muted" id="owner-secret-help">SELF_HOST_SETUP_TOKEN from your deployment settings. Keep it private.</span>
        </div>}
        <div className="settings-field">
          <label className="field-label" htmlFor="owner-password">{setup ? "New password" : "Password"}</label>
          <input id="owner-password" className="field" type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={256} required disabled={busy} aria-describedby={setup ? "owner-password-help" : undefined} />
          {setup && <span className="muted" id="owner-password-help">At least 12 characters. Save it in your password manager.</span>}
        </div>
        {setup && <div className="settings-field">
          <label className="field-label" htmlFor="owner-confirmation">Confirm password</label>
          <input id="owner-confirmation" className="field" type="password" autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required maxLength={256} disabled={busy} />
        </div>}
        {error && <p className="setup-error" role="alert">{error}</p>}
        {error && setup && <button type="button" className="btn link" onClick={() => location.reload()}>Reload sign-in options</button>}
        <button className="btn primary block" type="submit" disabled={busy || !password || (setup && (!secret || !confirmation))}>
          {busy ? "Signing in…" : setup ? "Save password and continue" : "Sign in as owner"}
        </button>
      </form>
      {passwordConfigured && <details className="setup-note muted">
        <summary className="btn link">Forgot your password?</summary>
        <p className="muted">Generate a new random SELF_HOST_SETUP_TOKEN in your deployment settings, redeploy, then reload this page. Old setup secrets cannot be reused. Resetting revokes existing account sign-ins.</p>
        {setupRequired && <button type="button" className="btn link" disabled={busy} onClick={() => { setSetup(!setup); setError(""); setPassword(""); setConfirmation(""); setSecret(""); }}>
          {setup ? "Back to password sign-in" : "Reset owner password"}
        </button>}
      </details>}
    </section>
  );
}
