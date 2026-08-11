#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** First-class BYO-agent convenience CLI backed by the ordinary plugin manifest. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { currentBivyVersion } from "./app-version.js";
import { defaultDataDir } from "./data-dir.js";
import { recommendedBivyRange, type PluginManifest } from "./plugin-sdk/index.js";
import { installPlugin, listInstalledPlugins, removePlugin } from "./plugins/store.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const valued = new Set(["--command", "--transport", "--adapter", "--args", "--name", "--prompt-mode", "--data-dir"]);
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valued.has(args[index]!)) { index += 1; continue; }
    if (!args[index]!.startsWith("-")) out.push(args[index]!);
  }
  return out;
}

function fail(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(value: string | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("--args must be a JSON string array"); }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("--args must be a JSON string array");
  }
  return parsed;
}

function localManifest(args: string[]): PluginManifest {
  const id = positional(args)[1]?.trim().toLowerCase() ?? "";
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error("Agent id must be a lowercase slug of 2-48 characters");
  const command = option(args, "--command")?.trim();
  if (!command) throw new Error("--command is required");
  const transport = (option(args, "--transport") ?? option(args, "--adapter") ?? "acp").toLowerCase();
  if (transport !== "acp" && transport !== "process") throw new Error("--transport must be acp or process");
  const adapterArgs = parseArgs(option(args, "--args"));
  const name = option(args, "--name")?.trim() || id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  const promptModeValue = option(args, "--prompt-mode") ?? "stdin";
  if (promptModeValue !== "stdin" && promptModeValue !== "argv") throw new Error("--prompt-mode must be stdin or argv");
  const promptMode: "stdin" | "argv" = promptModeValue;
  return {
    apiVersion: "bivy.sh/v1alpha1",
    kind: "Plugin",
    metadata: {
      id,
      name,
      version: "0.1.0",
      description: `Local integration for the ${name} agent.`,
    },
    requires: { bivy: recommendedBivyRange(currentBivyVersion()) },
    contributes: {
      agents: [{
        id,
        name,
        authOwner: "agent",
        adapter: transport === "acp"
          ? { kind: "acp", command, ...(adapterArgs.length ? { args: adapterArgs } : {}) }
          : { kind: "process", command, ...(adapterArgs.length ? { args: adapterArgs } : {}), promptMode },
      }],
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const json = args.includes("--json");
  const dataDir = path.resolve(option(args, "--data-dir") ?? defaultDataDir());

  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  bivy agent add <id> --command <command> [--transport acp|process] [--args '["..."]']
  bivy agent list [--json]
  bivy agent remove <integration-id>

Adds an existing user-owned agent through the same declarative package contract used by every external integration.`);
    return;
  }

  try {
    if (command === "add") {
      const manifest = localManifest(args);
      const existingPackage = listInstalledPlugins(dataDir).some((plugin) => plugin.id === manifest.metadata.id);
      if (!existingPackage) {
        const runtimeModule = await import("./runtime/index.js");
        const retained = runtimeModule.canonicalAgentId(manifest.contributes.agents[0]!.id);
        if (retained) throw new Error(`Agent id ${manifest.contributes.agents[0]!.id} conflicts with retained integration ${retained}; choose a unique id`);
      }
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-agent-add-"));
      const file = path.join(temp, "bivy.plugin.yaml");
      try {
        fs.writeFileSync(file, stringifyYaml(manifest), { mode: 0o600 });
        const result = installPlugin(file, { dataDir, force: args.includes("--force"), bivyVersion: currentBivyVersion() });
        const body = { ok: true, id: manifest.metadata.id, path: result.path, replaced: result.replaced, restartRequired: true };
        if (json) console.log(JSON.stringify(body, null, 2));
        else {
          console.log(`${result.replaced ? "Updated" : "Added"} agent integration ${manifest.metadata.name} (${manifest.metadata.id}).`);
          console.log("Restart Bivy to activate it: bivy restart");
        }
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
      return;
    }

    if (command === "list" || command === "ls") {
      const rows = listInstalledPlugins(dataDir).flatMap((plugin) =>
        plugin.manifest?.contributes.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          package: plugin.id,
          version: plugin.manifest!.metadata.version,
          transport: agent.adapter.kind,
          command: agent.adapter.command,
          status: plugin.errors.length ? "invalid" : "installed",
        })) ?? [],
      );
      if (json) console.log(JSON.stringify({ ok: true, agents: rows }, null, 2));
      else if (!rows.length) console.log("No installed agent integration packages.");
      else for (const row of rows) console.log(`${row.id}\t${row.transport}\t${row.command}\t${row.package}@${row.version}`);
      return;
    }

    if (command === "remove" || command === "rm") {
      const id = positional(args)[1];
      if (!id) fail("Usage: bivy agent remove <integration-id>", json);
      const installed = listInstalledPlugins(dataDir);
      const direct = installed.find((plugin) => plugin.id === id);
      const matches = direct ? [direct] : installed.filter((plugin) =>
        plugin.manifest?.contributes.agents.some((agent) => agent.id === id),
      );
      if (matches.length > 1) throw new Error(`Agent id ${id} is contributed by multiple invalid packages; remove one with bivy plugin remove <package-id>`);
      const packageId = matches[0]?.id ?? id;
      const removed = removePlugin(packageId, dataDir);
      if (json) console.log(JSON.stringify({ ok: true, id, packageId, removed }));
      else console.log(removed ? `Removed ${id} (${packageId}). Restart Bivy to deactivate it.` : `Agent integration ${id} is not installed.`);
      return;
    }

    fail(`Unknown agent command: ${command}`, json);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), json);
  }
}

await main();
