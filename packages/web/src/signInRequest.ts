// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Reactive "the user asked to sign in" flag. A solo (account-free QR) pairing
// skips the sign-in gate entirely — by design, it needs no account — so the
// account-only surfaces (Automations, cloud machine profiles) need a way to
// summon the sign-in screen on demand instead of dead-ending on a 401. Exposed
// as a subscribe/getSnapshot pair like settingsRoute, but deliberately NOT
// URL-backed: a reload should land back in the working solo app, never on a
// sign-in screen the user didn't just ask for.

const listeners = new Set<() => void>();
let requested = false;

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeSignInRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSignInRequest(): boolean {
  return requested;
}

/** Show the sign-in screen over the running app (solo pairings only — a
 *  loopback/direct client has no control plane behind its origin to sign into). */
export function requestSignIn(): void {
  requested = true;
  notify();
}

export function dismissSignInRequest(): void {
  requested = false;
  notify();
}
