// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The PWA install suggestion: contextual (only after a first successful
// response), driven by the browser's one-shot beforeinstallprompt event, and
// permanently dismissible. Runs the real pwaLifecycle module against a minimal
// window (EventTarget + storage) instead of a browser page.
import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }),
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  },
});
const pwa = await import("../packages/web/src/pwaLifecycle.js");

function installPrompt(outcome: "accepted" | "dismissed") {
  let prompted = 0;
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: async () => { prompted += 1; },
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
  return { event, prompted: () => prompted };
}

const stop = pwa.initializeInstallLifecycle();

test("install is offered only after a first successful response, then prompts once", async () => {
  const offer = installPrompt("accepted");
  window.dispatchEvent(offer.event);
  assert.equal(offer.event.defaultPrevented, true, "the browser's mini-infobar is suppressed");
  assert.equal(pwa.getPwaLifecycleState().installChoice, null, "no suggestion before the first success");
  pwa.markFirstSuccessfulResponse();
  assert.equal(pwa.getPwaLifecycleState().installChoice, "native");
  assert.equal(await pwa.requestInstall(), "accepted");
  assert.equal(offer.prompted(), 1);
  assert.equal(await pwa.requestInstall(), "unavailable", "the prompt event is one-shot");
});

test("dismissal is permanent for this profile, even when the browser offers again", () => {
  window.dispatchEvent(installPrompt("dismissed").event);
  assert.equal(pwa.getPwaLifecycleState().installChoice, "native");
  pwa.dismissInstall();
  assert.equal(pwa.getPwaLifecycleState().installChoice, null);
  window.dispatchEvent(installPrompt("dismissed").event);
  assert.equal(pwa.getPwaLifecycleState().installChoice, null);
  assert.equal(values.get("bivy.pwa.install-dismissed"), "1");
  stop();
});
