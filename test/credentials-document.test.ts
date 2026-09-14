// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Unit spec for the v3 credential-vault document engine (src/credentials/document.ts):
// v1/v2/v3 migration + non-destructive merge convergence. Pure — no vault, no I/O.
// These are the v2 credential-store merge rules re-keyed to `provider:label` records.

import assert from "node:assert/strict";

import {
  migrateToV3,
  mergeDocuments,
  preferIncomingRecord,
  tombstoneWinsRecord,
  recordFromStored,
  emptyDocument,
  type CredentialVaultDocumentV3,
} from "../src/credentials/document.js";
import { credKey, type CredentialRecord } from "../src/credentials/records.js";

const K = (provider: string, label = "default") => credKey(provider, label);

function api(provider: string, label: string, key: string): CredentialRecord {
  return { provider, label, origin: "bivy", sync: "account", source: { kind: "stored", cred: { type: "api_key", key } } };
}
function oauth(
  provider: string,
  label: string,
  o: Partial<{ access: string; refresh: string; expires: number; refreshedAt: number }>,
): CredentialRecord {
  return {
    provider,
    label,
    origin: "bivy",
    sync: "account",
    source: {
      kind: "stored",
      cred: {
        type: "oauth",
        access: o.access ?? "a",
        refresh: o.refresh ?? "r",
        expires: o.expires ?? 0,
        ...(o.refreshedAt !== undefined ? { refreshedAt: o.refreshedAt } : {}),
      },
    },
  };
}

// --- migration: v1 legacy bare provider→StoredCredential map ----------------
{
  const doc = migrateToV3({ anthropic: { type: "api_key", key: "sk-1" }, openai: { type: "api_key", key: "sk-2" } });
  assert.equal(doc.v, 3);
  assert.equal(doc.credentials[K("anthropic")].label, "default", "legacy creds migrate to provider:default");
  const src = doc.credentials[K("openai")].source;
  assert.equal(src.kind, "stored");
  assert.equal(src.kind === "stored" && src.cred.type === "api_key" ? src.cred.key : undefined, "sk-2");
  assert.equal(doc.credentials[K("anthropic")].sync, "account", "migrated creds default to opt-out account sync");
  assert.equal(doc.credentials[K("anthropic")].origin, "bivy");
}

// --- migration: v2 document, tombstones re-keyed to provider:default --------
{
  const doc = migrateToV3({
    v: 2,
    providers: { anthropic: { type: "api_key", key: "sk-1", updatedAt: 5 } },
    deletedAt: { openai: 99 },
  });
  assert.equal(doc.credentials[K("anthropic")].updatedAt, 5, "carries the store-owned updatedAt");
  assert.equal(doc.deletedAt[K("openai")], 99, "tombstone re-keyed to openai:default");
  assert.equal(doc.deletedAt["openai"], undefined, "old provider-keyed tombstone is gone");
}

// --- migration: v3 round-trips and normalizes the key -----------------------
{
  const src: CredentialVaultDocumentV3 = {
    v: 3,
    credentials: {
      X: {
        provider: "Anthropic",
        label: "Work",
        origin: "bivy",
        sync: "node",
        source: { kind: "stored", cred: { type: "api_key", key: "k" } },
      },
    },
    deletedAt: {},
  };
  const doc = migrateToV3(src);
  assert.ok(doc.credentials[K("anthropic", "work")], "re-keyed by natural key, normalized to lowercase");
  assert.equal(doc.credentials[K("anthropic", "work")].sync, "node", "preserves per-record sync policy");
}

// --- migration: garbage → empty ---------------------------------------------
assert.deepEqual(migrateToV3(null), emptyDocument());
assert.deepEqual(migrateToV3(42), emptyDocument());
assert.deepEqual(migrateToV3([1, 2, 3]), emptyDocument());

// --- recordFromStored -------------------------------------------------------
{
  const r = recordFromStored("Anthropic", { type: "api_key", key: "k", updatedAt: 7 });
  assert.equal(r.provider, "anthropic");
  assert.equal(r.label, "default");
  assert.equal(r.updatedAt, 7);
}

// --- preferIncomingRecord: freshest-wins, rotation-safe ---------------------
assert.equal(preferIncomingRecord(undefined, api("a", "l", "x")), true, "no local → take incoming");
assert.equal(preferIncomingRecord(api("a", "l", "x"), api("a", "l", "y")), true, "api-key change wins");
assert.equal(
  preferIncomingRecord(oauth("a", "l", { refresh: "good" }), oauth("a", "l", { refresh: "" })),
  false,
  "a blank incoming refresh never clobbers a usable one",
);
assert.equal(preferIncomingRecord(oauth("a", "l", { refreshedAt: 10 }), oauth("a", "l", { refreshedAt: 20 })), true);
assert.equal(preferIncomingRecord(oauth("a", "l", { refreshedAt: 20 }), oauth("a", "l", { refreshedAt: 20 })), false, "tie keeps local");
assert.equal(preferIncomingRecord(oauth("a", "l", { expires: 100 }), oauth("a", "l", { expires: 200 })), true, "fall back to expires");
assert.equal(preferIncomingRecord(oauth("a", "l", { expires: 200 }), oauth("a", "l", { expires: 100 })), false);

// --- tombstoneWinsRecord: newer-wins ----------------------------------------
assert.equal(tombstoneWinsRecord(undefined, 5), true);
assert.equal(tombstoneWinsRecord({ ...api("a", "l", "x"), updatedAt: 10 }, 5), false);
assert.equal(tombstoneWinsRecord({ ...api("a", "l", "x"), updatedAt: 10 }, 20), true);
assert.equal(tombstoneWinsRecord(api("a", "l", "x"), 0), false, "a zero/absent stamp never wins");

// --- merge: import new, skip identical, keep the fresher local login ---------
{
  const local = migrateToV3({
    v: 3,
    credentials: { [K("anthropic")]: { ...api("anthropic", "default", "local"), updatedAt: 100 } },
    deletedAt: {},
  });
  const r1 = mergeDocuments(local, { [K("openai")]: api("openai", "default", "new") });
  assert.equal(r1.imported, 1);
  assert.equal(r1.document.credentials[K("openai")].source.kind, "stored");

  const r2 = mergeDocuments(r1.document, { [K("openai")]: api("openai", "default", "new") });
  assert.equal(r2.changed, false, "an identical re-state is a no-op (no churn / re-encrypt)");

  const localO: CredentialVaultDocumentV3 = {
    v: 3,
    credentials: { [K("g")]: oauth("g", "default", { refreshedAt: 50, refresh: "r2" }) },
    deletedAt: {},
  };
  const r3 = mergeDocuments(localO, { [K("g")]: oauth("g", "default", { refreshedAt: 10, refresh: "r1" }) });
  const kept = r3.document.credentials[K("g")].source;
  assert.equal(kept.kind === "stored" && kept.cred.type === "oauth" ? kept.cred.refreshedAt : undefined, 50, "fresher local oauth kept");
}

// Codex rotation race: A refreshes r1→r2, then B uploads its stale r1 copy.
// The token mint stamp, not B's later store write/sync time, decides. Applying
// the snapshots in either direction must converge on r2.
{
  const stale = { ...oauth("openai-codex", "default", { access: "a1", refresh: "r1", expires: 500, refreshedAt: 100 }), updatedAt: 900 };
  const rotated = { ...oauth("openai-codex", "default", { access: "a2", refresh: "r2", expires: 400, refreshedAt: 200 }), updatedAt: 300 };
  const staleDoc: CredentialVaultDocumentV3 = { v: 3, credentials: { [K("openai-codex")]: stale }, deletedAt: {} };
  const rotatedDoc: CredentialVaultDocumentV3 = { v: 3, credentials: { [K("openai-codex")]: rotated }, deletedAt: {} };
  const staleThenRotated = mergeDocuments(staleDoc, rotatedDoc.credentials).document;
  const rotatedThenStale = mergeDocuments(rotatedDoc, staleDoc.credentials).document;
  assert.deepEqual(staleThenRotated.credentials[K("openai-codex")], rotated);
  assert.deepEqual(rotatedThenStale.credentials[K("openai-codex")], rotated);
}

// --- merge: a newer snapshot tombstone removes an older local cred -----------
{
  const local: CredentialVaultDocumentV3 = {
    v: 3,
    credentials: { [K("x")]: { ...api("x", "default", "old"), updatedAt: 10 } },
    deletedAt: {},
  };
  const r = mergeDocuments(local, {}, { [K("x")]: 20 });
  assert.equal(r.document.credentials[K("x")], undefined, "newer tombstone removes the older credential");
  assert.equal(r.document.deletedAt[K("x")], 20);

  const r2 = mergeDocuments(r.document, { [K("x")]: { ...api("x", "default", "fresh"), updatedAt: 30 } });
  const src = r2.document.credentials[K("x")].source;
  assert.equal(src.kind === "stored" && src.cred.type === "api_key" ? src.cred.key : undefined, "fresh", "a later re-login supersedes the tombstone");
}

// --- merge is pure: it never mutates its inputs -----------------------------
{
  const local: CredentialVaultDocumentV3 = { v: 3, credentials: {}, deletedAt: {} };
  mergeDocuments(local, { [K("z")]: api("z", "default", "k") });
  assert.deepEqual(local.credentials, {}, "mergeDocuments does not mutate the local document");
}

console.log("credentials-document: all tests passed");
