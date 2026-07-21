import assert from "node:assert/strict";
import path from "node:path";
import { codexAuthFile, codexCredentialPreflight, CODEX_NO_CREDENTIAL_MESSAGE } from "../src/runtime/codex-preflight.js";

// Codex authenticates via OPENAI_API_KEY or its own `codex login` auth file.
// Bivy's vault forwards API keys but cannot hand off a ChatGPT subscription, so
// the preflight must let the turn run when either credential exists and return a
// clear, actionable message when neither does — instead of the opaque upstream
// "unexpected status 401 Unauthorized: Missing bearer …".

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

const noFiles = { fileExists: () => false, home: "/home/tester" };

check("passes when OPENAI_API_KEY is present in the env", () => {
  assert.equal(codexCredentialPreflight({ OPENAI_API_KEY: "sk-abc" }, noFiles), undefined);
});

check("passes when a codex login auth file exists", () => {
  const authFile = codexAuthFile({ home: "/home/tester" });
  const exists = (p: string) => p === authFile;
  assert.equal(codexCredentialPreflight({}, { fileExists: exists, home: "/home/tester" }), undefined);
});

check("blocks with an actionable message when neither credential exists", () => {
  const msg = codexCredentialPreflight({}, noFiles);
  assert.equal(msg, CODEX_NO_CREDENTIAL_MESSAGE);
  assert.ok(/codex login/.test(msg!), "message points at `codex login`");
  assert.ok(/OpenAI API key/i.test(msg!), "message points at adding an API key");
});

check("a blank/whitespace OPENAI_API_KEY does not count as a credential", () => {
  assert.equal(codexCredentialPreflight({ OPENAI_API_KEY: "   " }, noFiles), CODEX_NO_CREDENTIAL_MESSAGE);
});

check("CODEX_HOME override relocates the auth file", () => {
  assert.equal(codexAuthFile({ codexHome: "/custom/codex" }), path.join("/custom/codex", "auth.json"));
  const exists = (p: string) => p === path.join("/custom/codex", "auth.json");
  assert.equal(codexCredentialPreflight({}, { fileExists: exists, codexHome: "/custom/codex" }), undefined);
});

check("default auth file resolves under ~/.codex", () => {
  assert.equal(codexAuthFile({ home: "/home/tester", codexHome: "" }), path.join("/home/tester", ".codex", "auth.json"));
});

if (failures > 0) {
  console.error(`\n${failures} codex-preflight test(s) failed`);
  process.exit(1);
}
console.log("\nall codex-preflight tests passed");
