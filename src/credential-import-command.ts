// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createCredentialVault } from "./runtime/credential-store.js";
import { discoverNativeAuth, nativeAuthSources, type NativeAuthAgent } from "./runtime/native-auth-import.js";
import { normalizeLabel, type SyncPolicy } from "./credentials/records.js";

export async function importNativeAuthCommand(credsDir: string, args: string[]): Promise<void> {
  let sync: SyncPolicy | undefined;
  let yes = false;
  let dryRun = false;
  let label = "default";
  const agents: NativeAuthAgent[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--sync") {
      const value = args[++i];
      if (value !== "node" && value !== "account") throw new Error("--sync requires node or account");
      sync = value;
    } else if (arg === "--label") {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error("--label requires a name");
      label = normalizeLabel(value);
    } else if (Object.hasOwn(nativeAuthSources, arg)) agents.push(arg as NativeAuthAgent);
    else throw new Error("Usage: bivy auth import [claude codex grok] [--sync node|account] [--label name] [--yes] [--dry-run]");
  }
  const selected = [...new Set(agents.length ? agents : Object.keys(nativeAuthSources) as NativeAuthAgent[])];
  const found = selected.map(discoverNativeAuth);
  const vault = createCredentialVault(credsDir);
  const candidates = [];
  for (const item of found) {
    if (item.status !== "found") {
      console.log(`${item.agent}: ${item.status} credential file (keychain-only logins are not supported).`);
      continue;
    }
    const existing = await vault.readRecord(item.provider, label);
    console.log(`${item.agent}: ${item.provider}:${label} (${item.credential.type === "oauth" ? "OAuth" : "API key"})${existing ? " — skipped: slot already exists; use --label to keep both" : " — ready to import"}`);
    if (!existing) candidates.push(item);
  }
  console.log("Subscription logins work only with compatible providers/runtimes; access has not been verified.");
  console.log("Native logins are left unchanged. Concurrent OAuth refresh by native CLIs or other machines may require re-login.");
  if (dryRun || !candidates.length) return;
  if (!stdin.isTTY && (!yes || !sync)) throw new Error("Non-interactive import requires --yes and --sync node|account. Use --dry-run to preview.");
  if (yes && !sync) throw new Error("--yes requires an explicit --sync node|account.");
  if (!yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      if (!sync) {
        const answer = (await rl.question("Store on this node, or E2E sync across your account nodes? [node/account] (node): ")).trim().toLowerCase();
        if (answer && answer !== "node" && answer !== "account") throw new Error("Expected node or account; nothing imported.");
        sync = answer === "account" ? "account" : "node";
      }
      const answer = await rl.question(`Import ${candidates.length} credential(s), scope ${sync}? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) { console.log("Cancelled; nothing imported."); return; }
    } finally { rl.close(); }
  }
  for (const item of candidates) {
    const inserted = await vault.putRecordIfAbsent({
      provider: item.provider, label, origin: "agent-native", sync: sync!,
      source: { kind: "stored", cred: item.credential },
    });
    console.log(`${item.provider}:${label}: ${inserted ? `imported (${sync})` : "skipped: slot changed during import"}.`);
  }
  console.log(sync === "account"
    ? "Eligible for E2E account sync when the enrolled Bivy daemon is running; delivery is not yet confirmed."
    : "Stored locally. Use 'bivy credentials sync <provider> <label> account' to enable account sync later.");
  if (label !== "default") console.log("Select this label with 'bivy credentials preset set <preset> <provider> <label>' and 'bivy credentials preset use <preset>'.");
  console.log("Agent-managed auth is unchanged; compatible runtimes must use Bivy-managed auth to consume the vault.");
}
