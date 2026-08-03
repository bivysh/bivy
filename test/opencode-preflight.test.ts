import assert from "node:assert/strict";
import { opencodeCredentialPreflight, opencodeNoCredentialMessage } from "../src/runtime/opencode-preflight.js";

// `opencode run` boots OpenCode's own server, which 500s with an opaque
// `UnknownError: Unexpected server error` (plus an `err_…` ref pointing at a log
// Bivy can't read) when the selected provider has no credential. The preflight
// is provider-aware — OpenCode models are `provider/model` ids — and must let a
// run proceed when the selected provider's key is present, block with an
// actionable message when it's absent, and stay out of the way when it can't
// tell which provider is in play.

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

check("passes when the selected provider's key is present (openai/gpt-5)", () => {
  assert.equal(opencodeCredentialPreflight({ OPENAI_API_KEY: "sk-abc" }, { provider: "openai" }), undefined);
});

check("passes for anthropic via ANTHROPIC_API_KEY", () => {
  assert.equal(opencodeCredentialPreflight({ ANTHROPIC_API_KEY: "sk-ant" }, { provider: "anthropic" }), undefined);
});

check("passes for anthropic via a Claude Code OAuth token", () => {
  assert.equal(opencodeCredentialPreflight({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" }, { provider: "anthropic" }), undefined);
});

check("passes for google via GEMINI_API_KEY", () => {
  assert.equal(opencodeCredentialPreflight({ GEMINI_API_KEY: "g-key" }, { provider: "google" }), undefined);
});

check("blocks with an actionable message when the selected provider's key is missing", () => {
  const msg = opencodeCredentialPreflight({}, { provider: "openai" });
  assert.equal(msg, opencodeNoCredentialMessage("openai", "OPENAI_API_KEY"));
  assert.ok(/OPENAI_API_KEY/.test(msg!), "message names the env var Bivy would pass");
  assert.ok(/Keys & OAuth/.test(msg!), "message points at where to add the key");
  assert.ok(/Openai/.test(msg!), "message names the provider");
});

check("does NOT count another provider's key for the selected provider", () => {
  // GPT-5 selected but only an Anthropic key present — OpenCode would still 500.
  const msg = opencodeCredentialPreflight({ ANTHROPIC_API_KEY: "sk-ant" }, { provider: "openai" });
  assert.equal(msg, opencodeNoCredentialMessage("openai", "OPENAI_API_KEY"));
});

check("a blank/whitespace key does not count as a credential", () => {
  assert.equal(
    opencodeCredentialPreflight({ OPENAI_API_KEY: "   " }, { provider: "openai" }),
    opencodeNoCredentialMessage("openai", "OPENAI_API_KEY"),
  );
});

check("stays out of the way when no provider is known", () => {
  // No model/provider selected → don't block; an on-disk `opencode auth` login
  // may authenticate the run.
  assert.equal(opencodeCredentialPreflight({}, {}), undefined);
  assert.equal(opencodeCredentialPreflight({}, { provider: "  " }), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} opencode-preflight test(s) failed`);
  process.exit(1);
}
console.log("\nall opencode-preflight tests passed");
