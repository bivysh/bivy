#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./data-dir.js";
import { installPlugin, installedAgentContributions, listInstalledPlugins, pluginStoreDir, readPluginManifest, removePlugin } from "./plugins/store.js";

function usage(exitCode = 0): never {
  console.log(`Usage: bivy plugin <command> [options]

Install and inspect declarative Bivy plugins.

Commands:
  validate <path>          Validate a bivy.plugin.yaml/json manifest
  install <path> [--force] Install into this node's plugin store
  list [--json]            List installed plugins and diagnostics
  remove <id>              Remove an installed plugin

Options:
  --json                   Emit machine-readable JSON
  --force                  Replace an installed plugin with the same id

Plugins are node-local. Restart the Bivy node after install/remove so background
services and terminal commands load the same contribution set.`);
  process.exit(exitCode);
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function agentConflictDiagnostics(dataDir: string): string[] {
  const installed = installedAgentContributions(dataDir);
  const errors = [...installed.errors];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reserved = new Set<string>([
    "pi", "claude", "claude-code", "claude-code-sdk", "generic-cli", "codex-approvals",
    "openclaw", "bivy-agent-protocol", "acp", "openhands", "swe-agent",
    "openai-agents-sdk", "langgraph", "google-adk", "autogen", "crew-ai",
  ]);
  try {
    const builtins = JSON.parse(fs.readFileSync(path.join(root, "bin", "agent-manifest.json"), "utf8"));
    for (const agent of builtins?.agents ?? []) if (typeof agent?.id === "string") reserved.add(agent.id);
  } catch { /* a broken release is diagnosed by `bivy agents`; retain native ids */ }
  const configured = new Set<string>();
  try {
    const custom = JSON.parse(process.env.BIVY_CUSTOM_AGENTS ?? "[]");
    for (const agent of Array.isArray(custom) ? custom : []) if (typeof agent?.id === "string") configured.add(agent.id.toLowerCase());
  } catch { /* malformed custom config is diagnosed by config validation */ }
  for (const contribution of installed.agents) {
    const id = contribution.agent.id;
    if (reserved.has(id)) errors.push(`${contribution.pluginId}: agent id ${id} conflicts with a built-in runtime`);
    else if (configured.has(id)) errors.push(`${contribution.pluginId}: agent id ${id} conflicts with node configuration`);
  }
  return errors;
}

function fail(error: unknown, json: boolean): never {
  const message = error instanceof Error ? error.message : String(error);
  if (json) outputJson({ ok: false, error: message });
  else console.error(`error: ${message}`);
  process.exit(1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) usage();
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const dataDir = defaultDataDir();

  try {
    if (command === "validate") {
      const input = positional[0];
      if (!input) fail("Usage: bivy plugin validate <path>", json);
      const { file, manifest } = readPluginManifest(input);
      const result = {
        ok: true,
        file,
        plugin: { id: manifest.metadata.id, name: manifest.metadata.name, version: manifest.metadata.version },
        contributions: { agents: manifest.contributes.agents.map((agent) => ({ id: agent.id, adapter: agent.adapter.kind })) },
      };
      if (json) outputJson(result);
      else {
        console.log(`Valid plugin: ${manifest.metadata.name} (${manifest.metadata.id}@${manifest.metadata.version})`);
        console.log(`Agents: ${result.contributions.agents.map((agent) => `${agent.id} [${agent.adapter}]`).join(", ")}`);
      }
      return;
    }

    if (command === "install" || command === "add") {
      const input = positional[0];
      if (!input) fail("Usage: bivy plugin install <path> [--force]", json);
      const result = installPlugin(input, { dataDir, force: args.includes("--force") });
      const body = {
        ok: true,
        installed: result.manifest.metadata.id,
        version: result.manifest.metadata.version,
        path: result.path,
        replaced: result.replaced,
        restartRequired: true,
      };
      if (json) outputJson(body);
      else {
        console.log(`${result.replaced ? "Updated" : "Installed"} ${result.manifest.metadata.name} (${result.manifest.metadata.id}@${result.manifest.metadata.version}).`);
        console.log(`Stored at ${result.path}`);
        console.log("Restart Bivy to activate it: bivy restart");
      }
      return;
    }

    if (command === "list" || command === "ls") {
      const plugins = listInstalledPlugins(dataDir);
      const conflicts = agentConflictDiagnostics(dataDir);
      const body = {
        ok: conflicts.length === 0 && plugins.every((plugin) => plugin.errors.length === 0),
        directory: pluginStoreDir(dataDir),
        plugins: plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.manifest?.metadata.name,
          version: plugin.manifest?.metadata.version,
          agents: plugin.manifest?.contributes.agents.map((agent) => ({ id: agent.id, adapter: agent.adapter.kind })) ?? [],
          status: plugin.errors.length ? "invalid" : "installed",
          errors: plugin.errors,
        })),
        errors: conflicts,
      };
      if (json) outputJson(body);
      else if (!plugins.length) {
        console.log(`No plugins installed. Store: ${body.directory}`);
      } else {
        console.log(`Plugins (${body.directory})`);
        for (const plugin of body.plugins) {
          const detail = plugin.status === "installed"
            ? `${plugin.name} ${plugin.version} · ${plugin.agents.map((agent) => `${agent.id} [${agent.adapter}]`).join(", ")}`
            : `invalid · ${plugin.errors.join("; ")}`;
          console.log(`  ${plugin.id}: ${detail}`);
        }
        for (const error of body.errors) console.error(`  warning: ${error}`);
      }
      if (!body.ok) process.exitCode = 1;
      return;
    }

    if (command === "remove" || command === "rm" || command === "uninstall") {
      const id = positional[0];
      if (!id) fail("Usage: bivy plugin remove <id>", json);
      const removed = removePlugin(id, dataDir);
      if (!removed) fail(`Plugin ${id} is not installed`, json);
      const body = { ok: true, removed: id, restartRequired: true };
      if (json) outputJson(body);
      else {
        console.log(`Removed plugin ${id}.`);
        console.log("Restart Bivy to unload it: bivy restart");
      }
      return;
    }

    usage(1);
  } catch (error) {
    fail(error, json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
