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

/** Mask credentials in `text`. Safe on non-string / empty input. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(URL_CREDENTIAL, `$1:${REDACTED}@`)
    .replace(GH_TOKEN, REDACTED)
    .replace(GH_FINE_PAT, REDACTED);
}
