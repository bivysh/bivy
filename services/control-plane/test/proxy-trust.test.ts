// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { configureProxyTrust } from "../src/proxy-trust.js";
import { createOwnerAuthRouter } from "../src/owner-auth.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

const store = createPgMemStore();
await store.init();
let server: Server | undefined;
let base = "";
async function start(trustedProxies?: string) {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  const app = express();
  // Same configuration entry point as the production app. The HTTP connection
  // is the proxy; X-Forwarded-For is the client address it forwards.
  configureProxyTrust(app, trustedProxies);
  app.use(express.json());
  app.get("/ip", (req, res) => { res.json({ ip: req.ip }); });
  app.use("/auth/owner", createOwnerAuthRouter({ store, publicUrl: "https://app.example.com", relayUrl: "wss://relay.example.com" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
}
async function ip(forwarded: string) {
  return (await fetch(`${base}/ip`, { headers: { "x-forwarded-for": forwarded } }).then(r => r.json())).ip;
}
async function login(forwarded: string) {
  return (await fetch(`${base}/auth/owner/login`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
    body: JSON.stringify({ password: "incorrect owner password" }),
  })).status;
}
try {
  for (const value of [undefined, "", "  ", "192.0.2.0/24"]) {
    await start(value);
    assert.equal(await ip("198.51.100.1"), "127.0.0.1", "untrusted peers cannot spoof a forwarded client IP");
  }
  for (const value of ["true", "false", "1", "not-a-subnet"]) {
    assert.throws(() => configureProxyTrust(express(), value), /TRUST_PROXY|invalid IP address/);
  }
  // Compose uses uniquelocal for its private Docker ingress; generic container
  // hosts select their ingress addresses. Verify both use address-based trust.
  const composeApp = express();
  configureProxyTrust(composeApp, "uniquelocal");
  const trust = composeApp.get("trust proxy fn") as (address: string) => boolean;
  assert.equal(trust("172.20.0.2"), true);
  assert.equal(trust("198.51.100.1"), false);

  await start(" 127.0.0.1/32, ::1/128 ");
  assert.equal(await ip("198.51.100.1"), "198.51.100.1");
  assert.equal(await ip("203.0.113.99, 198.51.100.1"), "198.51.100.1", "stop at the first untrusted hop, not a spoofed leftmost header");
  for (let i = 0; i < 10; i++) assert.equal(await login("198.51.100.1"), 401);
  assert.equal(await login("203.0.113.99, 198.51.100.1"), 429, "spoofing a prefix cannot evade the per-client budget");
  assert.equal(await login("198.51.100.2"), 401, "another visitor behind the same proxy has a separate budget");
  await start("loopback");
  assert.equal(await login("198.51.100.1"), 429, "durable IP budget survives router replacement");
  assert.equal(await login("198.51.100.3"), 401, "durable limit must not use the shared proxy address either");
  for (let i = 0; i < 10; i++) assert.equal(await login("2001:db8:10::1"), 401);
  assert.equal(await login("2001:db8:10::2"), 429, "local limiter groups an IPv6 client subnet");
  await start("loopback");
  assert.equal(await login("2001:db8:10::3"), 429, "durable limiter uses the same IPv6 subnet grouping");
  assert.equal(await login("2001:db8:20::1"), 401, "another IPv6 subnet retains its own budget");
  console.log("proxy trust: fail-closed defaults, address allowlists, forwarded-chain spoofing and independent durable owner limits passed");
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await store.close();
}
