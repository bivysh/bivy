// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { createPgMemStore } from "../src/pg-mem-store.js";
import { operatorLoginLink } from "../src/operator-login.js";
import { LOGIN_TOKEN_TTL_MS } from "../src/store.js";

const store = createPgMemStore();
await store.init();
const now = Date.now;
try {
  for (const url of ["http://app.example.com", "https://user:pass@app.example.com", "https://app.example.com/subpath", "https://app.example.com/?redirect=evil", "https://app.example.com/#fragment"]) {
    await assert.rejects(operatorLoginLink(store, "owner@self-host.invalid", url));
  }
  for (const email of ["", "bad", "owner@localhost", "owner@example.com\nOTHER=secret"]) {
    await assert.rejects(operatorLoginLink(store, email, "https://app.example.com"));
  }
  const link = new URL(await operatorLoginLink(store, "Owner@self-host.invalid", "https://app.example.com"));
  assert.equal(link.origin, "https://app.example.com");
  assert.equal(link.pathname, "/auth/magic-link/consume");
  const token = link.searchParams.get("token")!;
  assert.ok(token.startsWith("mlt_"));
  assert.equal(await store.consumeLoginToken("not-a-token"), undefined);
  const results = await Promise.all([store.consumeLoginToken(token), store.consumeLoginToken(token)]);
  assert.equal(results.filter(Boolean).length, 1, "one-use even when two consumers race");
  const account = results.find(Boolean)!;
  assert.equal(account.email, "owner@self-host.invalid");
  const session = await store.createSession(account.id);
  assert.equal((await store.accountFromSession(session))?.id, account.id);

  const recovery = new URL(await operatorLoginLink(store, account.email, link.origin));
  const recovered = await store.consumeLoginToken(recovery.searchParams.get("token")!);
  assert.equal(recovered?.id, account.id, "recovery must not create a new owner account");
  const expired = new URL(await operatorLoginLink(store, account.email, link.origin));
  const timestamp = now();
  Date.now = () => timestamp + LOGIN_TOKEN_TTL_MS + 1000;
  assert.equal(await store.consumeLoginToken(expired.searchParams.get("token")!), undefined);
  Date.now = now;
  assert.equal(await store.consumeLoginToken(token), undefined, "a consumed link stays consumed");
  console.log("operator login: origin/identity validation, normal sessions, recovery, expiry and single-use consumption passed");
} finally {
  Date.now = now;
  await store.close();
}
