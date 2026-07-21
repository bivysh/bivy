// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// `bivy voice` — configure speech-to-text (voice input) from the terminal.
//
// Mirrors the web app's Settings → Voice input panel: pick a preferred provider
// and store a per-provider API key (encrypted in the SecretVault). Keeps CLI and
// React in parity via the shared helpers in stt.ts.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STT_PROVIDERS,
  getSttConfig,
  isSttProvider,
  removeSttKey,
  resolveSttKey,
  setSttKey,
  setSttProvider,
  sttProviderList,
  type SttProvider,
} from "./stt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");

async function askHidden(question: string): Promise<string> {
  if (!input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
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
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
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

function usage() {
  console.log(`Usage: bivy voice <status|provider|key|remove>

Commands:
  bivy voice                         Show the current provider and which keys are set
  bivy voice status                  (same as above)
  bivy voice provider <groq|openai>  Choose the preferred transcription provider
  bivy voice key <groq|openai> [key] Store an API key (prompts when the key is omitted)
  bivy voice remove <groq|openai>    Forget a stored API key

Providers:
  groq     ${STT_PROVIDERS.groq.model} — fast, low cost, strong multilingual
  openai   ${STT_PROVIDERS.openai.model} — top accuracy
`);
}

function parseProvider(value: string | undefined): SttProvider {
  if (!isSttProvider(value)) {
    throw new Error(`Provider must be one of: ${sttProviderList().join(", ")}`);
  }
  return value;
}

async function printStatus() {
  const config = await getSttConfig(appDir);
  console.log(`Preferred provider: ${config.provider}`);
  for (const p of config.providers) {
    const active = p.id === config.provider ? " (preferred)" : "";
    console.log(`  ${p.configured ? "✓" : "·"} ${p.id.padEnd(7)} ${p.label} — ${p.model}${active}`);
  }
  console.log(
    config.providers.some((p) => p.configured)
      ? ""
      : "\nNo keys set yet. Run 'bivy voice key groq' or 'bivy voice key openai'.",
  );
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  switch (cmd) {
    case "status":
      await printStatus();
      return;
    case "provider": {
      const provider = parseProvider(arg);
      setSttProvider(appDir, provider);
      console.log(`Preferred voice provider set to ${provider}.`);
      if (!(await resolveSttKey(appDir, provider))) {
        console.log(`No key stored for ${provider} yet — run 'bivy voice key ${provider}'.`);
      }
      return;
    }
    case "key": {
      const provider = parseProvider(arg);
      const value = rest.join(" ").trim() || (await askHidden(`${STT_PROVIDERS[provider].label} API key: `));
      setSttKey(appDir, provider, value);
      console.log(`Saved ${provider} key.`);
      return;
    }
    case "remove": {
      const provider = parseProvider(arg);
      console.log(removeSttKey(appDir, provider) ? `Removed ${provider} key.` : `No ${provider} key was stored.`);
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
