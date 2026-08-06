// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Post-login redirect helpers. Kept side-effect free (no server boot) so the
// open-redirect protection can be unit tested in isolation.

// Whitespace or C0/C1 control characters — a crafted value carrying these could
// smuggle a second header or otherwise break the Location redirect.
const UNSAFE_REDIRECT_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * Sanitize a caller-supplied post-login redirect target. Sign-in ends with a
 * redirect to `<path>#<payload>`, so a client served under a sub-path can ask
 * to land back where it started instead of defaulting to root — otherwise a
 * sign-in begun from a scoped path (an installed PWA whose manifest scope is a
 * sub-path, say) sends OAuth outside that scope and the finished session never
 * returns to the app window (the sign-in loop that reads as being "redirected
 * back in a split second").
 *
 * Only same-origin absolute paths are honored — never a protocol-relative
 * `//host`, a scheme (`https:…`), or a backslash-obfuscated form — so this can
 * never become an open redirect. Anything else falls back to `fallback`.
 */
export function safeReturnPath(raw: unknown, fallback = "/"): string {
  const value = String(raw ?? "").trim();
  if (value === "/") return value;
  // Require exactly one leading slash followed by a non-slash, non-backslash
  // char: rejects "", "//evil.com", "/\\evil.com", "https://evil.com", "evil".
  if (!/^\/[^/\\]/.test(value)) return fallback;
  if (UNSAFE_REDIRECT_CHARS.test(value)) return fallback;
  return value;
}
