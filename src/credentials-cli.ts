// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// `bivy credentials` — CLI parity with the PWA's Keys & OAuth screen: manage
// multiple labeled credentials per provider, per-credential sync, selection
// presets, and the agent-native ingest policy. Operates directly on the node's
// vault + `credentials.config.json` (no running daemon required), through the
// same api.ts surface the daemon uses.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import {
  listCredentialRecords,
  setProviderApiKeyLabeled,
  setProviderReferenceLabeled,
  removeProviderCredential,
  setCredentialSync,
  getCredentialPresets,
  setActiveCredentialPreset,
  setCredentialPresetMapping,
  getCredentialIngestPolicy,
  setCredentialIngestPolicy,
  type CredentialRecordSummary,
} from "./credentials/api.js";
import { defaultPresetsPath, inferReferenceBackend } from "./credentials/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = process.env.BIVY_DATA_DIR ?? path.join(repoRoot, ".bivy");
const credsDir = path.join(appDir, "credentials");
const configPath = defaultPresetsPath(credsDir);

function usage(): void {
  console.log(`Usage: bivy credentials <command>

Credentials (multiple labeled keys/accounts per provider):
  bivy credentials list                              List labeled credentials (never prints secrets)
  bivy credentials add <provider> <label> [value]    Add/replace a credential (prompts when value omitted).
                                                     value = an API key, or a reference: op://… / env://NAME / cmd://<command>
  bivy credentials remove <provider> <label>         Forget one labeled credential
  bivy credentials sync <provider> <label> node|account   Keep on this node, or sync across your nodes

Presets (which labeled key a project uses):
  bivy credentials preset list
  bivy credentials preset use <name>                 Set the active preset ("" clears it)
  bivy credentials preset set <name> <provider> <label>   Map a provider→label in a preset
  bivy credentials preset clear <name> <provider>    Remove a provider's mapping from a preset

Agent-native logins:
  bivy credentials ingest [merge|separate]           Show or set the ingest policy

Config file (${path.relative(process.cwd(), configPath) || configPath}):
  bivy credentials config path|show|edit             Print path, show, or open in $EDITOR

Note: run 'bivy provider login' to add a provider's default OAuth/API-key login.`);
}

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

function kindLabel(r: CredentialRecordSummary): string {
  if (r.kind === "reference") return `reference ${r.ref ?? ""}`.trim();
  return r.kind === "oauth" ? "OAuth" : "API key";
}

async function cmdList(): Promise<void> {
  const records = [...(await listCredentialRecords(credsDir))].sort((a, b) =>
    `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
  if (records.length === 0) { console.log("No credentials. Add one with 'bivy credentials add', or 'bivy provider login'."); return; }
  const presets = getCredentialPresets(credsDir);
  for (const r of records) {
    const badges = [kindLabel(r), r.sync === "account" ? "sync" : "node-only", r.origin === "agent-native" ? "from agent" : null]
      .filter(Boolean).join(" · ");
    console.log(`${r.provider}:${r.label}  (${badges})`);
  }
  if (presets.active) console.log(`\nActive preset: ${presets.active}`);
}

async function cmdAdd(provider: string, label: string, value?: string): Promise<void> {
  if (!provider || !label) throw new Error("Usage: bivy credentials add <provider> <label> [value]");
  let v = value;
  if (v === undefined) v = (await askHidden(`Value for ${provider}:${label} (API key, or op://… / env://NAME / cmd://…): `)).trim();
  v = String(v ?? "").trim();
  if (!v) throw new Error("No value provided");
  if (inferReferenceBackend(v)) {
    await setProviderReferenceLabeled(credsDir, provider, label, v);
    console.log(`Added reference ${provider}:${label}.`);
  } else {
    await setProviderApiKeyLabeled(credsDir, provider, label, v);
    console.log(`Added ${provider}:${label}.`);
  }
}

async function cmdPreset(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "list") {
    const p = getCredentialPresets(credsDir);
    console.log(`Active preset: ${p.active ?? "(none — providers use their default key)"}`);
    const names = Object.keys(p.presets ?? {});
    if (names.length === 0) { console.log("No presets. Create one with 'bivy credentials preset set <name> <provider> <label>'."); return; }
    for (const name of names) {
      console.log(`\n${name}${name === p.active ? " (active)" : ""}`);
      for (const [prov, lbl] of Object.entries(p.presets?.[name] ?? {})) console.log(`  ${prov} → ${lbl}`);
    }
    return;
  }
  if (sub === "use") { setActiveCredentialPreset(credsDir, rest[0] ?? ""); console.log(rest[0] ? `Active preset: ${rest[0]}` : "Cleared active preset."); return; }
  if (sub === "set") {
    const [name, prov, lbl] = rest;
    if (!name || !prov || !lbl) throw new Error("Usage: bivy credentials preset set <name> <provider> <label>");
    setCredentialPresetMapping(credsDir, name, prov, lbl);
    console.log(`Preset "${name}": ${prov} → ${lbl}`);
    return;
  }
  if (sub === "clear") {
    const [name, prov] = rest;
    if (!name || !prov) throw new Error("Usage: bivy credentials preset clear <name> <provider>");
    setCredentialPresetMapping(credsDir, name, prov, "");
    console.log(`Preset "${name}": cleared ${prov}`);
    return;
  }
  throw new Error("Unknown preset command. Try: list | use | set | clear");
}

async function cmdIngest(arg?: string): Promise<void> {
  if (!arg) { console.log(`Ingest policy: ${getCredentialIngestPolicy(credsDir)}`); return; }
  if (arg !== "merge" && arg !== "separate") throw new Error("Usage: bivy credentials ingest [merge|separate]");
  setCredentialIngestPolicy(credsDir, arg);
  console.log(`Ingest policy: ${arg}`);
}

async function cmdConfig(sub?: string): Promise<void> {
  if (!sub || sub === "path") { console.log(configPath); return; }
  if (sub === "show") { console.log(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").trimEnd() : "{}"); return; }
  if (sub === "edit") {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, "{\n}\n", { mode: 0o600 });
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [configPath], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited with ${code}`))));
    });
    return;
  }
  throw new Error("Usage: bivy credentials config path|show|edit");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") { usage(); return; }
  switch (command) {
    case "list": return cmdList();
    case "add": return cmdAdd(args[0], args[1], args[2]);
    case "remove": case "rm":
      if (!args[0] || !args[1]) throw new Error("Usage: bivy credentials remove <provider> <label>");
      await removeProviderCredential(credsDir, args[0], args[1]);
      console.log(`Removed ${args[0]}:${args[1]}.`);
      return;
    case "sync":
      if (!args[0] || !args[1] || (args[2] !== "node" && args[2] !== "account")) throw new Error("Usage: bivy credentials sync <provider> <label> node|account");
      await setCredentialSync(credsDir, args[0], args[1], args[2]);
      console.log(`${args[0]}:${args[1]} → ${args[2] === "account" ? "syncing across nodes" : "this node only"}`);
      return;
    case "preset": case "presets": return cmdPreset(args);
    case "ingest": return cmdIngest(args[0]);
    case "config": return cmdConfig(args[0]);
    default: usage(); process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
