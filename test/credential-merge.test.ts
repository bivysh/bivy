import assert from "node:assert/strict";
import { preferIncomingCredential, type StoredCredential } from "../src/runtime/credential-store.js";

// The pure cross-node merge decision (credential-store.importAll). Freshest-wins,
// rotation-safe: a lagging / refresh-less snapshot must never clobber a fresher
// local login, ties keep local, and `refreshedAt` (mint order) beats `expires`
// (which clock skew can inflate).

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const oauth = (o: Partial<StoredCredential> & { refresh?: string; expires?: number; refreshedAt?: number }): StoredCredential => ({
  type: "oauth",
  access: "a",
  refresh: o.refresh ?? "r",
  expires: o.expires ?? 1000,
  ...(o.refreshedAt !== undefined ? { refreshedAt: o.refreshedAt } : {}),
});
const apiKey = (key: string): StoredCredential => ({ type: "api_key", key });

test("no local entry → take the incoming credential", () => {
  assert.equal(preferIncomingCredential(undefined, oauth({})), true);
});

test("refreshedAt (mint order) decides, strictly-newer wins; tie keeps local", () => {
  const local = oauth({ refreshedAt: 100, expires: 5000 });
  assert.equal(preferIncomingCredential(local, oauth({ refreshedAt: 200, expires: 1 })), true);  // newer mint wins even with lower expiry
  assert.equal(preferIncomingCredential(local, oauth({ refreshedAt: 50, expires: 9999 })), false); // older mint loses despite higher expiry
  assert.equal(preferIncomingCredential(local, oauth({ refreshedAt: 100, expires: 9999 })), false); // tie keeps local
});

test("clock skew: without refreshedAt, expires decides but a tie keeps local", () => {
  const local = oauth({ expires: 1000 });
  assert.equal(preferIncomingCredential(local, oauth({ expires: 2000 })), true);  // strictly newer wins
  assert.equal(preferIncomingCredential(local, oauth({ expires: 1000 })), false); // equal expires keeps local (was: clobbered)
  assert.equal(preferIncomingCredential(local, oauth({ expires: 500 })), false);  // older loses
});

test("a snapshot missing the refresh token never clobbers a usable one", () => {
  const local = oauth({ refresh: "live", expires: 1000 });
  // Even with a higher expires, a blank incoming refresh must not win.
  assert.equal(preferIncomingCredential(local, oauth({ refresh: "", expires: 9999 })), false);
  assert.equal(preferIncomingCredential(local, oauth({ refresh: "  ", expires: 9999 })), false);
  // A local that itself lacks a refresh can be replaced by a fresher real one
  // (the guard only blocks a BLANK incoming; freshness still decides otherwise).
  assert.equal(preferIncomingCredential(oauth({ refresh: "", expires: 1000 }), oauth({ refresh: "new", expires: 2000 })), true);
});

test("mixed refreshedAt presence falls back to expires", () => {
  // Incoming has a mint stamp, local doesn't → not both finite → expires decides.
  assert.equal(preferIncomingCredential(oauth({ expires: 1000 }), oauth({ refreshedAt: 5, expires: 2000 })), true);
  assert.equal(preferIncomingCredential(oauth({ expires: 3000 }), oauth({ refreshedAt: 9, expires: 2000 })), false);
});

test("non-OAuth cases keep the prior 'incoming replaces' behavior", () => {
  assert.equal(preferIncomingCredential(apiKey("old"), apiKey("new")), true);
  assert.equal(preferIncomingCredential(apiKey("k"), oauth({})), true);   // type switch to oauth
  assert.equal(preferIncomingCredential(oauth({}), apiKey("k")), true);   // oauth → api key (intentional replace)
});

console.log(`credential-merge: all ${passed} tests passed`);
