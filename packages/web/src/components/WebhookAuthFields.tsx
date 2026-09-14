// SPDX-License-Identifier: AGPL-3.0-only
export function WebhookAuthFields({ mode, header, secret, existing, onMode, onHeader, onSecret }: {
  mode: "hmac" | "header";
  header: string;
  secret: string;
  existing: boolean;
  onMode: (mode: "hmac" | "header") => void;
  onHeader: (header: string) => void;
  onSecret: (secret: string) => void;
}) {
  return <>
    <div className="settings-field">
      <label className="field-label" htmlFor="webhook-auth-mode">Authentication method</label>
      <select id="webhook-auth-mode" className="picker-search" value={mode} onChange={(event) => onMode(event.target.value as "hmac" | "header")}>
        <option value="hmac">HMAC-SHA256 signature (recommended)</option>
        <option value="header">Static secret header</option>
      </select>
      <p className="settings-hint">{mode === "hmac"
        ? "The sender signs the raw request body with your secret. The header value is sha256= followed by the hexadecimal HMAC digest, not the secret itself."
        : "The sender puts the exact secret value in this header. Use HTTPS; unlike HMAC, this does not bind authentication to the request body."}</p>
    </div>
    <div className="settings-field">
      <label className="field-label" htmlFor="webhook-auth-header">Header name</label>
      <input id="webhook-auth-header" className="picker-search" value={header} maxLength={128} spellCheck={false} onChange={(event) => onHeader(event.target.value)} />
    </div>
    <div className="settings-field">
      <label className="field-label" htmlFor="webhook-auth-secret">{mode === "hmac" ? "Custom signing secret (optional)" : "Custom header value (optional)"}</label>
      <input id="webhook-auth-secret" className="picker-search" type="password" autoComplete="new-password" value={secret} minLength={32} maxLength={256} onChange={(event) => onSecret(event.target.value)} />
      <p className="settings-hint">{existing ? "Leave blank to keep the current secret. Enter a value to replace it immediately on save." : "Leave blank to generate a secure secret on save."} Custom values must be 32–256 printable characters. Secrets are never included in list responses.</p>
    </div>
  </>;
}
