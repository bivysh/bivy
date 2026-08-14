import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_STT_PROVIDER,
  getSttConfig,
  getSttProvider,
  isSttProvider,
  removeSttKey,
  resolveSttKey,
  setSttKey,
  setSttProvider,
  sttKeyId,
  transcribeAudio,
} from "../src/stt.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-stt-"));

// Provider guard
assert.ok(isSttProvider("groq"));
assert.ok(isSttProvider("openai"));
assert.ok(!isSttProvider("whisper"));
assert.ok(!isSttProvider(undefined));

// Default provider before anything is written
assert.equal(getSttProvider(dir), DEFAULT_STT_PROVIDER);

// Preferred provider round-trips through settings.json without clobbering siblings
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ approvalMode: "autonomous" }));
setSttProvider(dir, "openai");
assert.equal(getSttProvider(dir), "openai");
const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
assert.equal(settings.approvalMode, "autonomous", "unrelated settings must be preserved");
assert.equal(settings.sttProvider, "openai");

// Keys use the unified encrypted model credential vault and resolve back.
await setSttKey(dir, "groq", "gsk_test_key");
assert.equal(await resolveSttKey(dir, "groq"), "gsk_test_key");
const credentialsRaw = fs.readFileSync(path.join(dir, "credentials", "auth.enc"), "utf8");
assert.ok(!credentialsRaw.includes("gsk_test_key"), "STT key must not be written in plaintext");
assert.ok(!fs.existsSync(path.join(dir, "secrets.json")), "new voice keys must not create a second secret vault entry");
assert.equal(sttKeyId("groq"), "stt.groq");

// Config status reflects which keys exist and the preferred provider
const config = await getSttConfig(dir);
assert.equal(config.provider, "openai");
assert.equal(config.providers.find((p) => p.id === "groq")?.configured, true);
assert.equal(config.providers.find((p) => p.id === "openai")?.configured, false);

// Env-var fallback when no vault key is stored
process.env.OPENAI_API_KEY = "sk-env-fallback";
assert.equal(await resolveSttKey(dir, "openai"), "sk-env-fallback");
delete process.env.OPENAI_API_KEY;

// Removing a key clears it
assert.equal(await removeSttKey(dir, "groq"), true);
assert.equal(await resolveSttKey(dir, "groq"), undefined);

// transcribeAudio surfaces a clear, actionable error when no key is available
await assert.rejects(
  () => transcribeAudio({ appDir: dir, audio: Buffer.from("x"), provider: "groq" }),
  /No API key set for Groq/,
);
// ...and refuses empty audio before making any network call
await assert.rejects(
  () => transcribeAudio({ appDir: dir, audio: Buffer.alloc(0), provider: "openai" }),
  /No audio was recorded/,
);

console.log("stt tests passed");
