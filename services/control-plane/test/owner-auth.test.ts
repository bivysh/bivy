// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { createOwnerAuthRouter, hashOwnerPassword, verifyOwnerPassword } from "../src/owner-auth.js";
import { hashToken } from "../src/store.js";

const store = createPgMemStore();
await store.init();
const secret = "a".repeat(64), replacement = "b".repeat(64);
const password = "correct horse battery staple";
let server: Server | undefined;
let base = "";
let ip = 1;
async function start(setupToken?: string) {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/auth/owner", createOwnerAuthRouter({ store, setupToken, publicUrl: "https://app.example.com", relayUrl: "wss://relay.example.com", github: false, email: false }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Missing server address");
  base = `http://127.0.0.1:${address.port}/auth/owner`;
}
async function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip++}`, ...headers }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  return { status: response.status, data };
}
try {
  assert.throws(() => createOwnerAuthRouter({ store, setupToken: "short", publicUrl: "https://app.example.com", relayUrl: "wss://relay.example.com" }), /SELF_HOST_SETUP_TOKEN/);
  const encoded = await hashOwnerPassword(password);
  assert.notEqual(encoded, await hashOwnerPassword(password), "random salts");
  assert.equal(await verifyOwnerPassword(password, encoded), true);
  assert.equal(await verifyOwnerPassword("a wrong but long password", encoded), false);
  assert.equal(await verifyOwnerPassword(password, "scrypt-v1$malformed"), false);
  await assert.rejects(hashOwnerPassword("short"));
  await assert.rejects(hashOwnerPassword("🚀".repeat(100)), /256/);

  await start();
  assert.deepEqual(await fetch(`${base}/status`).then(r => r.json()), { enabled: false, passwordConfigured: false, setupRequired: false, github: false, email: false });
  assert.equal((await post("setup", { setupToken: secret, password })).status, 401);
  await start(secret);
  assert.equal((await fetch(`${base}/status`).then(r => r.json())).setupRequired, true);
  assert.equal((await post("setup", { setupToken: "wrong", password })).status, 401);
  assert.equal((await post("setup", { setupToken: secret, password: "short" })).status, 400);
  assert.equal((await post("setup", { setupToken: secret, password }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("setup", { setupToken: secret, password }, { "content-type": "text/plain" })).status, 415);
  const setup = await post("setup", { setupToken: secret, password }, { origin: "https://app.example.com" });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.relayUrl, "wss://relay.example.com");
  const account = await store.accountFromSession(setup.data.token);
  assert.equal(account?.email, "owner@self-host.invalid");
  const owner = await store.selfHostOwner();
  assert.ok(owner);
  assert.notEqual(owner.passwordHash, password);
  assert.equal(await store.selfHostSetupTokenUsed(hashToken(secret)), true);
  assert.equal((await post("setup", { setupToken: secret, password: "attacker password long" })).status, 401);

  // Token consumption and password persist across a restart/removal of the
  // deployment bootstrap secret. No platform shell needed for everyday login.
  await start();
  assert.equal((await fetch(`${base}/status`).then(r => r.json())).enabled, true);
  assert.equal((await post("login", { password })).status, 200);
  assert.equal((await post("login", { password: "incorrect password" })).status, 401);
  await start(replacement);
  const nextPassword = "another strong owner password";
  const reset = await post("setup", { setupToken: replacement, password: nextPassword });
  assert.equal(reset.status, 200);
  assert.equal(await store.accountFromSession(setup.data.token), undefined, "reset revokes prior account sessions");
  assert.equal((await store.accountFromSession(reset.data.token))?.id, account?.id, "recovery preserves the account");
  assert.equal(await store.createSelfHostOwnerSession(owner.passwordHash), undefined, "stale verification cannot mint a session after reset");
  await start(secret);
  assert.equal((await fetch(`${base}/status`).then(r => r.json())).setupRequired, false, "even rotating back cannot re-arm an old setup token");
  assert.equal((await post("setup", { setupToken: secret, password })).status, 401);

  // Atomic DB claim, independent of the router's per-process hash limiter.
  const hash = hashToken("c".repeat(64));
  const attempts = await Promise.all([
    store.configureSelfHostOwner({ accountId: account!.id, passwordHash: encoded }, hash),
    store.configureSelfHostOwner({ accountId: account!.id, passwordHash: encoded }, hash),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1);
  await store.deleteAccount(account!.id);
  assert.equal(await store.createSelfHostOwnerSession(encoded), undefined);
  assert.equal(await store.selfHostSetupTokenUsed(hashToken(secret)), true, "account deletion does not resurrect setup credentials");

  // Shared rate limiter survives another router/process being constructed.
  await start();
  for (let i = 0; i < 11; i++) await post("login", { password: "incorrect password" }, { "x-forwarded-for": "198.51.100.1" });
  await start();
  assert.equal((await post("login", { password }, { "x-forwarded-for": "198.51.100.1" })).status, 429);
  console.log("owner auth: setup proof, password hashing, recovery, replay/races, session fencing, deletion and shared throttling passed");
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await store.close();
}
