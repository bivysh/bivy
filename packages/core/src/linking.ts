// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Device-link payload parsing. A QR/paste carries either the full
// remote.html#<base64url-json> URL or the bare encoded payload.
// Ported from public/app/linking.js.

export function base64UrlToJson(value: string): unknown {
  const text = String(value || "")
    .trim()
    .replace(/^#/, "");
  if (!text) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return JSON.parse(atob(b64));
}

export function linkPayloadFromText(text: string): unknown {
  let raw = String(text || "").trim();
  if (!raw) return null;
  try {
    raw = new URL(raw).hash.replace(/^#/, "") || raw;
  } catch {
    /* not a URL — treat as bare payload */
  }
  return base64UrlToJson(raw);
}
