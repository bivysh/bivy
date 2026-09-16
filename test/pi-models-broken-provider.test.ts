import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRuntime } from "../src/runtime/pi.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

// One broken provider must not blank the whole model catalog. Pi's runtime
// refreshes availability with a Promise.all across every provider's
// credential read/auth check, so a single failing provider (an unavailable
// pinned account, an unreachable custom endpoint) used to reject getModels()
// wholesale — the picker showed "No models available." and a Cloud launch
// waiting to validate its saved model dead-ended on the query timeout.
// getModels() must degrade to per-provider listing and skip only the broken
// provider; getAllModels() must tolerate the failed refresh the same way.

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-models-broken-"));
const sessionsDir = path.join(piDir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const store = createCredentialVault(piDir);
await store.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));
await store.putRecord({
  provider: "openai",
  label: "work",
  origin: "bivy",
  sync: "node",
  source: { kind: "stored", cred: { type: "api_key", key: "k" } },
});

const runtime = new PiRuntime({ credsDir: piDir, piDir, sessionsDir, allowModelNetwork: false });
// Pin openai to the labeled account so its credential read has a failure mode
// this test can trigger without the network: deleting the record below makes
// every openai read throw CredentialSelectionError.
const { session } = await runtime.createSession({ workspace: piDir, credentialLabels: { openai: "work" } });

const healthy = await session.getModels();
assert.ok(healthy.some((m) => m.provider === "anthropic"), "expected anthropic models while all providers are healthy");
assert.ok(healthy.some((m) => m.provider === "openai"), "expected openai models while all providers are healthy");

// The pinned openai account disappears (revoked on another device, pruned from
// a hosted snapshot…). Its credential read now throws.
await store.deleteRecord("openai", "work");

const degraded = await session.getModels();
assert.ok(degraded.length > 0, "a broken provider must not blank the whole connected-model list");
assert.ok(degraded.some((m) => m.provider === "anthropic"), "healthy providers must keep listing");
assert.ok(degraded.every((m) => m.provider !== "openai"), "the broken provider is skipped, not fabricated");

// The full catalog (connected + unconnected providers) must also survive the
// failed availability refresh instead of rejecting the whole picker payload.
const all = await session.getAllModels!();
assert.ok(all.length > 0, "getAllModels() must tolerate a failed availability refresh");
assert.ok(all.some((m) => m.provider === "anthropic" && m.configured === true), "connected providers keep their flag");

session.dispose();
fs.rmSync(piDir, { recursive: true, force: true });

console.log("pi broken-provider degrade OK (catalog survives one failing provider)");
