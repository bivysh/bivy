// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Device handoff: which device last drove a session, the draft it left, and
// what the next device offers because of it.
import assert from "node:assert/strict";
import test from "node:test";
import { PresenceBook, deviceFrom } from "../src/session/presence.js";
import { handoffFor } from "../packages/web/src/handoff.js";
import { deviceLabel } from "../packages/web/src/device.js";

const mac = { id: "web:mac", label: "Mac" };
const phone = { id: "web:phone", label: "iPhone" };

test("the driver is announced when it changes, not on every keystroke", () => {
  let now = 1_000;
  const book = new PresenceBook(() => now);
  assert.ok(book.drove("s1", mac, "terminal"), "first driver is announced");
  now += 5_000;
  assert.equal(book.drove("s1", mac, "terminal"), undefined, "the same device typing on is quiet");
  now += 5_000;
  assert.equal(book.drove("s1", phone, "chat")?.driver?.label, "iPhone", "a new device is announced");
  now += 31_000;
  assert.ok(book.drove("s1", phone, "chat"), "a long-running driver is re-announced so 'x ago' stays true");
});

test("a draft follows to the next device until its author sends it", () => {
  const book = new PresenceBook(() => 1_000);
  book.draft("s1", mac, "fix the login redirect");
  assert.equal(book.draft("s1", phone, "").draft?.text, "fix the login redirect", "another device clearing its own empty draft keeps the Mac's");
  assert.equal(book.drove("s1", phone, "chat")?.draft?.text, "fix the login redirect", "someone else sending doesn't consume it");
  assert.equal(book.drove("s1", mac, "chat")?.draft, undefined, "the author sending it does");
  assert.equal(deviceFrom({ id: "" }), undefined, "a device needs an id");
});

test("the next device offers the draft only into an empty composer, and never its own activity", () => {
  const presence = { sessionId: "s1", driver: { ...mac, via: "chat" as const, at: 1_000 }, draft: { device: mac, text: "half a prompt", at: 1_000 } };
  assert.deepEqual(handoffFor(presence, phone, true, 2_000), { from: "Mac", text: "half a prompt", at: 1_000 });
  assert.equal(handoffFor(presence, phone, false, 2_000), undefined, "never replaces what's typed here, and who drove last isn't a handoff");
  assert.equal(handoffFor(presence, mac, true, 2_000), undefined, "a device isn't told about itself");
  assert.equal(handoffFor(presence, phone, true, 1_000 + 31 * 60_000), undefined, "old activity isn't a handoff");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5), "iPad", "iPadOS reports itself as a Mac");
});
