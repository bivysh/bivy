// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Redact credentials from text before it is persisted to disk. Bivy stores
// session transcripts and tool-activity sidecars as JSON under `.bivy/`, and
// those files sync to the web/PWA — so any secret an agent happens to print
// (e.g. a tool running `git remote -v`, which surfaces the token baked into a
// clone's origin URL) would otherwise land in cleartext in a synced log.
//
// Applied at the single persistence choke point (EventLog.flush), so every
// base-transcript / tool-activity / intermediate-message write is scrubbed. Pattern-
// based and structure-preserving: it only ever shortens string *values*, so the
// surrounding JSON stays valid.

const REDACTED = "***REDACTED***";

// GitHub tokens in all current shapes:
//   ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_ (GitHub App user/installation),
//   ghr_ (refresh), and github_pat_ (fine-grained PAT).
const GH_TOKEN = /\bgh[posur]_[A-Za-z0-9]{16,255}\b/g;
const GH_FINE_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g;

// The password half of any URL userinfo — `scheme://user:SECRET@host`. Covers
// the `https://x-access-token:<token>@github.com/...` form Bivy writes into a
// clone's remote, plus any other basic-auth URL. Keeps the user, masks the rest.
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi;

// Model/provider and common SaaS API keys with distinctive, high-entropy
// prefixes — the shapes an agent most often prints via `env`/`cat .env`. These
// prefixes are specific enough that the minimum-length suffix guards keep false
// positives (redacting innocuous transcript text) negligible.
//   sk-… / sk-ant-… / sk-proj-…  OpenAI + Anthropic
//   sk_live_… / sk_test_… / rk_live_… / rk_test_…  Stripe secret + restricted
//   gsk_…  Groq
//   xai-…  xAI
//   AIza…  Google API keys
//   AKIA…  AWS access key id
//   xox[baprs]-…  Slack tokens
const PROVIDER_KEYS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bxai-[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

// Bivy's own bearer tokens — all minted as `<prefix>_` + `randomBytes(...).
// toString("base64url")` (see identity.ts's `mesh_` device tokens and the
// control-plane's `postgres-store.ts`):
//   mesh_…  device access token (identity.ts, `.bivy/node.json` creation flow)
//   enr_…   node enrollment token (relay-setup.ts, written to `.bivy/relay.json`)
//   sess_…  account session token (the bearer used while enrolling/pairing)
//   mlt_…   magic-link sign-in token
//   lnk_…   remote-device link grant
//   tkt_…   single-use relay ticket
const BIVY_TOKEN = /\b(?:mesh|enr|sess|mlt|lnk|tkt)_[A-Za-z0-9_-]{20,}\b/g;

// JWTs (three dot-separated base64url segments, header always decodes to `{"`
// so it always starts `eyJ`). Covers GitHub App JWTs (server.ts's
// `createAppJwt`) and any other JWT an agent might print.
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

// Generic `Authorization: Bearer <token>` — catches bearer credentials that
// don't match one of the specific shapes above (e.g. a third-party bearer an
// agent echoes while debugging a request). Case-insensitive on the scheme
// name; keeps "Bearer"/"bearer" as written and only masks the credential.
const BEARER_HEADER = /\b(bearer\s+)[A-Za-z0-9._-]{16,}\b/gi;

// Pairing secrets / room keys / private keys: high-entropy string *values*
// serialized right next to one of Bivy's own known secret-bearing field
// names (device-registry.ts, pairing-crypto.ts, server.ts's GitHub App vault).
// These are raw random bytes with no distinctive prefix of their own, so we
// key off the surrounding JSON field name instead — e.g.
// `"roomKeyB64":"<...>"` in a synced device-registry / vault write, or the
// account session forwarded as `"sessionToken":"<...>"` during pairing.
const KNOWN_SECRET_FIELDS = [
  "roomKeyB64",
  "privateKeyB64",
  "pairSecretB64",
  "pairSecret",
  "vaultKeyB64",
  "deviceSecret",
  "webhookSecret",
  "sessionToken",
  "enrollmentToken",
  "privateKeyPem",
];
const KNOWN_SECRET_FIELD_VALUE = new RegExp(
  `("(?:${KNOWN_SECRET_FIELDS.join("|")})"\\s*:\\s*")[^"\\\\]*(?:\\\\.[^"\\\\]*)*(")`,
  "g",
);

/** Mask credentials in `text`. Safe on non-string / empty input. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text
    .replace(URL_CREDENTIAL, `$1:${REDACTED}@`)
    .replace(GH_TOKEN, REDACTED)
    .replace(GH_FINE_PAT, REDACTED)
    .replace(BIVY_TOKEN, REDACTED)
    .replace(JWT, REDACTED)
    .replace(BEARER_HEADER, `$1${REDACTED}`)
    .replace(KNOWN_SECRET_FIELD_VALUE, `$1${REDACTED}$2`);
  for (const re of PROVIDER_KEYS) out = out.replace(re, REDACTED);
  return out;
}
