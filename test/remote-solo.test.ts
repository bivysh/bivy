// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { soloCredentials, buildDialUrl } from "../src/remote/solo.js";

test("soloCredentials requires BOTH room and roomToken", () => {
  assert.deepEqual(soloCredentials({ room: "r", roomToken: "t" }), { room: "r", roomToken: "t" });
  assert.equal(soloCredentials({ room: "r" }), null); // partial → not solo
  assert.equal(soloCredentials({ roomToken: "t" }), null);
  assert.equal(soloCredentials({}), null);
  assert.equal(soloCredentials({ room: "  ", roomToken: "t" }), null); // whitespace-only
});

test("soloCredentials trims surrounding whitespace", () => {
  assert.deepEqual(soloCredentials({ room: " r1 ", roomToken: " tok " }), { room: "r1", roomToken: "tok" });
});

test("buildDialUrl (hosted) presents a ticket for the given role", () => {
  assert.equal(buildDialUrl("wss://relay.example.com/", "node", { ticket: "abc" }), "wss://relay.example.com/node?ticket=abc");
  assert.equal(buildDialUrl("wss://relay.example.com", "client", { ticket: "a b/c" }), "wss://relay.example.com/client?ticket=a%20b%2Fc");
});

test("buildDialUrl (solo) presents room + roomToken, url-encoded", () => {
  assert.equal(
    buildDialUrl("wss://relay.example.com", "node", { room: "room_x", roomToken: "tok_y" }),
    "wss://relay.example.com/node?room=room_x&roomToken=tok_y",
  );
  // Encoding: values that contain URL-significant chars must be escaped.
  assert.equal(
    buildDialUrl("wss://r/", "client", { room: "a&b", roomToken: "t=z" }),
    "wss://r/client?room=a%26b&roomToken=t%3Dz",
  );
});

test("buildDialUrl strips exactly one trailing slash from the base", () => {
  assert.equal(buildDialUrl("wss://r", "node", { ticket: "t" }), "wss://r/node?ticket=t");
  assert.equal(buildDialUrl("wss://r/", "node", { ticket: "t" }), "wss://r/node?ticket=t");
});
