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

// Keys are stored encrypted in the vault (not plaintext) and resolve back
setSttKey(dir, "groq", "gsk_test_key");
assert.equal(await resolveSttKey(dir, "groq"), "gsk_test_key");
const secretsRaw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
assert.ok(!secretsRaw.includes("gsk_test_key"), "STT key must not be written in plaintext");
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
assert.equal(removeSttKey(dir, "groq"), true);
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
