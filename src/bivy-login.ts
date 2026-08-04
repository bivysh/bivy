// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createCredentialVault } from "./runtime/credential-store.js";
import { probeAnthropicAccess } from "./runtime/anthropic-preflight.js";
import { listPiProviders } from "./runtime/pi-oauth.js";
import { loginModelOAuth, type AuthInteraction, type AuthPrompt, type AuthEvent } from "./runtime/oauth/model-oauth.js";
import { openBrowser } from "./browser-open.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const piDir = path.join(dataDir, "pi");
// The shared, agent-neutral credential vault (not inside any agent's dir).
const credsDir = path.join(dataDir, "credentials");
const BEDROCK_PROVIDER_ID = "amazon-bedrock";

type AuthProvider = { id: string; name: string; authType: "oauth" | "api_key" };

async function makeProviders(): Promise<AuthProvider[]> {
  const catalog = await listPiProviders(credsDir, piDir);
  return catalog
    .map((provider): AuthProvider => ({ id: provider.id, name: provider.name, authType: provider.oauth ? "oauth" : "api_key" }))
    .sort((a, b) => `${a.name} ${a.authType}`.localeCompare(`${b.name} ${b.authType}`));
}

async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askHidden(question: string): Promise<string> {
  if (!input.isTTY) return askLine(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function choose<T extends { name: string; id: string }>(title: string, options: T[]): Promise<T> {
  if (options.length === 1) return options[0]!;
  console.log(`\n${title}`);
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option.name} (${option.id})`));
  while (true) {
    const answer = (await askLine("Select: ")).trim();
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index]!;
    const match = options.find((option) => option.id === answer || option.name.toLowerCase() === answer.toLowerCase());
    if (match) return match;
    console.log("Enter a number or provider id.");
  }
}

async function loginApiKey(provider: AuthProvider) {
  if (provider.id === BEDROCK_PROVIDER_ID) {
    console.log("Amazon Bedrock uses AWS credentials instead of a single API key.");
    console.log("Configure AWS_PROFILE, IAM keys, a Bedrock bearer token, or role-based credentials.");
    return;
  }
  const apiKey = (await askHidden(`Enter API key for ${provider.name}: `)).trim();
  if (!apiKey) throw new Error("API key cannot be empty.");
  await createCredentialVault(credsDir).setApiKey(provider.id, apiKey);
  console.log(`Saved API key for ${provider.name} to Bivy's credential vault.`);
  // B1: validate real access, not just that a key was typed, where a safe probe
  // exists. A rejected key is reported now instead of surfacing later as an
  // opaque 401 on the user's first task.
  if (provider.id === "anthropic") {
    const probe = await probeAnthropicAccess(apiKey);
    if (probe.probed && !probe.ok) {
      console.log(`⚠ ${probe.reason || "The key was saved but Anthropic rejected it."} Double-check the key; re-run 'bivy login' to replace it.`);
    } else if (probe.probed) {
      console.log("✓ Verified: the key can reach the Anthropic API.");
    }
  }
}

/** Bridge Pi's AuthInteraction to the terminal (prompt/notify). */
function terminalInteraction(provider: AuthProvider, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    notify(event: AuthEvent) {
      switch (event.type) {
        case "auth_url":
          console.log(`\nOpen this URL to login to ${provider.name}:\n${event.url}\n`);
          if (event.instructions) console.log(`${event.instructions}\n`);
          openBrowser(event.url);
          break;
        case "device_code":
          console.log(`\nOpen: ${event.verificationUri}`);
          console.log(`Enter code: ${event.userCode}`);
          console.log("Waiting for authentication…\n");
          break;
        case "info":
          console.log(event.message);
          for (const link of event.links ?? []) console.log(link.label ? `${link.label}: ${link.url}` : link.url);
          break;
        case "progress":
          console.log(event.message);
          break;
      }
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      switch (prompt.type) {
        case "secret":
          return (await askHidden(`${prompt.message} `)).trim();
        case "select": {
          const selected = await choose(prompt.message, prompt.options.map((option) => ({ id: option.id, name: option.label })));
          return selected.id;
        }
        case "text":
        case "manual_code":
        default:
          return (await askLine(`${prompt.message} `)).trim();
      }
    },
  };
}

async function loginOAuth(provider: AuthProvider) {
  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);
  try {
    await loginModelOAuth(credsDir, provider.id, terminalInteraction(provider, abort.signal));
    console.log(`Logged in to ${provider.name}. Credentials saved to Bivy's vault.`);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function main() {
  const requestedProvider = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  const providers = await makeProviders();

  if (providers.length === 0) throw new Error("No login providers are available.");

  let provider: AuthProvider | undefined;
  if (requestedProvider) {
    provider = providers.find((candidate) => candidate.id === requestedProvider || candidate.name.toLowerCase() === requestedProvider.toLowerCase());
    if (!provider) throw new Error(`Unknown provider: ${requestedProvider}`);
  } else {
    const authType = await choose("Authentication method", [
      { id: "oauth", name: "Use a subscription" },
      { id: "api_key", name: "Use an API key" },
    ]);
    provider = await choose("Provider", providers.filter((candidate) => candidate.authType === authType.id));
  }

  if (provider.authType === "oauth") await loginOAuth(provider);
  else await loginApiKey(provider);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
