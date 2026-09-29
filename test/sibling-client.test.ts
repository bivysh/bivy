// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SiblingClient } from "../src/session/sibling-client.js";

// A relay socket that behaves like the node's relay client: pair payloads are
// JSON strings both ways (src/remote/relay-client.ts ignores any other shape).
class FakeRelay extends EventEmitter {
  static last: FakeRelay;
  readyState = 1;
  sent: Array<{ t: string; p: unknown }> = [];
  constructor(_url: string) { super(); FakeRelay.last = this; queueMicrotask(() => this.emit("message", JSON.stringify({ t: "ready" }))); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.emit("close"); }
}

const fetchImpl = (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/node/sibling-link-grant") ? { grant: "g" } : { ticket: "t", relayUrl: "wss://relay.test" }))) as typeof fetch;
const client = (pairTimeoutMs?: number) => new SiblingClient({ controlPlaneUrl: "https://cp.test", enrollmentToken: "e", siblingNodeId: "node-b", fetchImpl, WebSocketImpl: FakeRelay as never, pairTimeoutMs });

test("pairing speaks the node's string payloads and fails instead of hanging", async () => {
  const refused = client().connect();
  await new Promise((r) => setTimeout(r, 10));
  const pair = FakeRelay.last.sent.find((m) => m.t === "pair");
  assert.equal(typeof pair?.p, "string", "pair.account goes out as a JSON string");
  assert.equal(JSON.parse(pair!.p as string).k, "pair.account");
  FakeRelay.last.emit("message", JSON.stringify({ t: "pair", p: JSON.stringify({ k: "pair.error", error: "not your account" }) }));
  await assert.rejects(refused, /not your account/, "the node's string reply is understood");
  await assert.rejects(client(30).connect(), /did not answer pairing/, "a silent sibling times out");
});
