// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "./secrets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const vault = new SecretVault(appDir);

async function askHidden(question: string): Promise<string> {
  if (!input.isTTY) {
    const rl = createInterface({ input, output });
    try { return await rl.question(question); } finally { rl.close(); }
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") { cleanup(); output.write("\n"); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { cleanup(); output.write("\n"); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    const cleanup = () => { input.off("data", onData); input.setRawMode(false); input.pause(); };
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function usage() {
  console.log(`Usage: bivy secrets <list|set|ref|delete|doctor|resolve>

Commands:
  bivy secrets list
  bivy secrets set <id> [value]       Store an encrypted local secret (prompts when value is omitted)
  bivy secrets ref <id> <op://...>    Store a 1Password reference instead of the raw secret
  bivy secrets ref <id> <env://VAR>   Store an environment-variable reference
  bivy secrets delete <id>
  bivy secrets doctor
  bivy secrets resolve <id>           Verify a secret resolves without printing it

Common ids:
  github.repo-token
  model.anthropic
  model.openai
  integration.github
`);
}

async function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { usage(); return; }

  if (cmd === "list") {
    const records = vault.list();
    if (records.length === 0) { console.log("No Bivy secrets configured."); return; }
    for (const record of records) {
      const target = record.backend === "local" ? "encrypted local" : record.ref;
      console.log(`${record.id}\t${record.backend}\t${target}\tupdated ${record.updatedAt}`);
    }
    return;
  }

  if (cmd === "set") {
    if (!id) throw new Error("Missing secret id.");
    const value = rest.length ? rest.join(" ") : await askHidden(`Secret value for ${id}: `);
    vault.setLocal(id, value);
    console.log(`✓ Stored ${id} in the encrypted local Bivy vault (${vault.file}).`);
    return;
  }

  if (cmd === "ref") {
    if (!id || rest.length === 0) throw new Error("Usage: bivy secrets ref <id> <op://...|env://VAR>");
    const ref = rest.join(" ").trim();
    vault.setReference(id, ref);
    console.log(`✓ Stored ${id} as ${ref}. Bivy will resolve it at runtime; the raw secret is not stored by Bivy.`);
    return;
  }

  if (cmd === "delete" || cmd === "rm") {
    if (!id) throw new Error("Missing secret id.");
    const removed = vault.delete(id);
    console.log(removed ? `✓ Deleted ${id}.` : `No secret named ${id}.`);
    return;
  }

  if (cmd === "resolve") {
    if (!id) throw new Error("Missing secret id.");
    const value = await vault.resolve(id);
    if (!value) throw new Error(`${id} did not resolve to a value.`);
    console.log(`✓ ${id} resolves (${value.length} bytes).`);
    return;
  }

  if (cmd === "doctor") {
    const result = await vault.doctor();
    for (const check of result.checks) console.log(`${check.ok ? "✓" : "!"} ${check.name}: ${check.detail}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
