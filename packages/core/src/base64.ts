// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Base64 / base64url helpers shared by crypto, linking, and push.
// Ported verbatim in behaviour from public/app/e2e.js and linking.js so the
// wire format stays byte-compatible with the node/relay peers.

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

export function unb64(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(str: string): Uint8Array {
  const raw = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
