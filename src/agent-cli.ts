#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** First-class bring-your-own-agent CLI: writes `agents:` in the node config.yaml. */
import fs from "node:fs";
import path from "node:path";
import { defaultDataDir } from "./data-dir.js";
import { mergeLegacyIntoNodeConfig, nodeConfigPath, readNodeConfig, writeNodeConfig, type NodeAgentConfig, type NodeConfig } from "./node-config.js";
import { listInstalledPlugins, removePlugin } from "./plugins/store.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const valued = new Set(["--command", "--transport", "--adapter", "--args", "--name", "--prompt-mode", "--parser", "--resume-args", "--data-dir"]);
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
  catch { throw new Error("--args and --resume-args must be JSON string arrays"); }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("--args and --resume-args must be JSON string arrays");
  }
  return parsed;
}

function readJson(dataDir: string, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

/** The node's config.yaml, or the one the daemon would create from legacy files
 *  — never a bare file that would skip that migration. */
function nodeConfig(dataDir: string): NodeConfig {
  return readNodeConfig(dataDir) ?? mergeLegacyIntoNodeConfig(readJson(dataDir, "cli.json"), readJson(dataDir, "settings.json"));
}

function agentId(args: string[]): string {
  const id = positional(args)[1]?.trim().toLowerCase() ?? "";
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) throw new Error("Agent id must be a lowercase slug of 2-48 characters");
  return id;
}

/** `bivy agent add` flags → the `adapter` block config.yaml and plugins share. */
function agentConfig(args: string[], id: string): NodeAgentConfig {
  const command = option(args, "--command")?.trim();
  if (!command) throw new Error("--command is required");
  const transport = (option(args, "--transport") ?? option(args, "--adapter") ?? "acp").toLowerCase();
  if (transport !== "acp" && transport !== "process") throw new Error("--transport must be acp or process");
  const adapterArgs = parseArgs(option(args, "--args"));
  const name = option(args, "--name")?.trim() || id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  if (transport === "acp") {
    for (const flag of ["--prompt-mode", "--parser", "--resume-args"]) if (option(args, flag)) throw new Error(`${flag} applies to --transport process only`);
    return { name, adapter: { kind: "acp", command, ...(adapterArgs.length ? { args: adapterArgs } : {}) } };
  }
  const promptMode = option(args, "--prompt-mode") ?? "stdin";
  if (promptMode !== "stdin" && promptMode !== "argv") throw new Error("--prompt-mode must be stdin or argv");
  const parser = option(args, "--parser");
  const resumeArgs = option(args, "--resume-args");
  return {
    name,
    adapter: {
      kind: "process",
      command,
      ...(adapterArgs.length ? { args: adapterArgs } : {}),
      promptMode,
      ...(parser ? { structured: { args: adapterArgs, parser } } : {}),
      ...(resumeArgs ? { resume: { args: parseArgs(resumeArgs) } } : {}),
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
  bivy agent add <id> --command <command> [--args '["..."]'] [--name <name>] [--force]
      ACP agent (default):  --transport acp
      Any other CLI:        --transport process [--prompt-mode stdin|argv]
                            [--parser <id>] [--resume-args '["...","{id}"]']
  bivy agent list [--json]
  bivy agent remove <id>

Agents are saved under agents: in <data-dir>/config.yaml and appear in the
picker right away. Edit that file directly for every adapter option.`);
    return;
  }

  try {
    if (command === "add") {
      const id = agentId(args);
      const spec = agentConfig(args, id);
      const config = nodeConfig(dataDir);
      const replaced = Boolean(config.agents?.[id]);
      if (replaced && !args.includes("--force")) throw new Error(`Agent ${id} is already configured; pass --force to replace it`);
      if (!replaced) {
        const runtimeModule = await import("./runtime/index.js");
        const retained = runtimeModule.canonicalAgentId(id);
        if (retained) throw new Error(`Agent id ${id} conflicts with ${retained}; choose a unique id`);
      }
      writeNodeConfig(dataDir, { ...config, agents: { ...config.agents, [id]: spec } });
      const body = { ok: true, id, path: nodeConfigPath(dataDir), replaced };
      if (json) console.log(JSON.stringify(body, null, 2));
      else console.log(`${replaced ? "Updated" : "Added"} ${"name" in spec ? spec.name : id} (${id}). It is in the agent picker now.`);
      return;
    }

    if (command === "list" || command === "ls") {
      const configured = Object.entries(readNodeConfig(dataDir)?.agents ?? {}).map(([id, spec]) => ({
        id,
        name: "adapter" in spec ? spec.name ?? id : spec.label ?? id,
        source: "config",
        transport: "adapter" in spec ? spec.adapter.kind : `extends ${spec.extends}`,
        command: "adapter" in spec ? spec.adapter.command : spec.command ?? spec.extends,
      }));
      const packaged = listInstalledPlugins(dataDir).flatMap((plugin) =>
        plugin.manifest?.contributes.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          source: `${plugin.id}@${plugin.manifest!.metadata.version}`,
          transport: agent.adapter.kind,
          command: agent.adapter.command,
          ...(plugin.errors.length ? { status: "invalid" } : {}),
        })) ?? [],
      );
      const rows = [...configured, ...packaged];
      if (json) console.log(JSON.stringify({ ok: true, agents: rows }, null, 2));
      else if (!rows.length) console.log("No agents added on this machine. Add one with: bivy agent add <id> --command <command>");
      else for (const row of rows) console.log(`${row.id}\t${row.transport}\t${row.command}\t${row.source}`);
      return;
    }

    if (command === "remove" || command === "rm") {
      const id = positional(args)[1];
      if (!id) fail("Usage: bivy agent remove <id>", json);
      const config = readNodeConfig(dataDir);
      if (config?.agents?.[id]) {
        const { [id]: _removed, ...agents } = config.agents;
        writeNodeConfig(dataDir, { ...config, agents });
        if (json) console.log(JSON.stringify({ ok: true, id, removed: true }));
        else console.log(`Removed ${id}.`);
        return;
      }
      // Agents added before config.yaml held them were single-agent plugin packages.
      const installed = listInstalledPlugins(dataDir);
      const direct = installed.find((plugin) => plugin.id === id);
      const matches = direct ? [direct] : installed.filter((plugin) =>
        plugin.manifest?.contributes.agents.some((agent) => agent.id === id),
      );
      if (matches.length > 1) throw new Error(`Agent id ${id} is contributed by multiple invalid packages; remove one with bivy plugin remove <package-id>`);
      const packageId = matches[0]?.id ?? id;
      const removed = removePlugin(packageId, dataDir);
      if (json) console.log(JSON.stringify({ ok: true, id, packageId, removed }));
      else console.log(removed ? `Removed ${id} (${packageId}).` : `Agent ${id} is not configured.`);
      return;
    }

    fail(`Unknown agent command: ${command}`, json);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), json);
  }
}

await main();
