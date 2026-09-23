// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { PostgresStore } from "../src/postgres-store.js";

const url = process.env.NATIVE_PUSH_TEST_DATABASE_URL;
if (!url) {
  console.log("SKIP native push PostgreSQL acceptance: set NATIVE_PUSH_TEST_DATABASE_URL to a disposable loopback database");
} else {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Disposable loopback database required");
  const pool = new pg.Pool({ connectionString: url });
  const store = new PostgresStore("", pool);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    await store.init();
    await pool.query("INSERT INTO accounts(id,email) VALUES ('push-a','push-a@example.invalid'),('push-b','push-b@example.invalid')");
    await pool.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES ($1,'push-a',now()+interval '1 day'),($2,'push-b',now()+interval '1 day')", [hash('auth-a'),hash('auth-b')]);
    const token = 'a'.repeat(64);
    await store.upsertNativePush('push-a', 'auth-a', token);
    const [first] = await store.listNativePush('push-a');
    assert.equal(first.token, token);
    await store.removeNativePush('push-b', token);
    assert.equal((await store.listNativePush('push-a')).length, 1, 'another account cannot delete registration');
    await store.upsertNativePush('push-a', 'auth-a', token);
    await store.removeNativePush('push-a', token, first.revision);
    assert.equal((await store.listNativePush('push-a')).length, 1, 'late APNs invalidation cannot delete refreshed registration');
    await store.upsertNativePush('push-b', 'auth-b', token);
    assert.equal((await store.listNativePush('push-a')).length, 0, 'device registration moves to current account');
    assert.equal((await store.listNativePush('push-b')).length, 1);
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash('auth-b')]);
    assert.equal((await store.listNativePush('push-b')).length, 0, 'revoked bearer cannot receive push');
    assert.equal((await pool.query("SELECT token FROM native_push_subscriptions WHERE account_id='push-b'")).rowCount, 0, 'revocation removes token storage');
    for (let i=0;i<16;i++) await store.upsertNativePush('push-a', 'auth-a', i.toString(16).padStart(64,'0'));
    await assert.rejects(store.upsertNativePush('push-a', 'auth-a', 'f'.repeat(64)), /limit/);
    await pool.query("UPDATE native_push_subscriptions SET updated_at=now()-interval '8 days' WHERE account_id='push-a'");
    assert.equal((await store.listNativePush('push-a')).length, 0, 'expired installation lease');
    await store.upsertNativePush('push-a', 'auth-a', 'f'.repeat(64));
    assert.equal((await store.listNativePush('push-a')).length, 1, 'expired registrations release slots');
    await pool.query("DELETE FROM accounts WHERE id IN ('push-a','push-b')");
    assert.equal((await pool.query('SELECT * FROM native_push_subscriptions')).rowCount, 0, 'account deletion cascades');
    console.log('PASS native push PostgreSQL ownership, revocation, lease, bounded admission and invalidation tests');
  } finally { await pool.end(); }
}
