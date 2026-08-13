#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DEFAULT_AUTOMATION_CONFIG_PATH, STARTER_AUTOMATION_CONFIG, parseAutomationConfig, parseSimulationEvent, simulateAutomation, type AutomationConfigEntry } from "./automation-config.js";
import { PairingStore } from "./device-registry.js";
import { NodeIdentity } from "./identity.js";
import { seal } from "./e2e.js";
import { readNodeConfig } from "./node-config.js";
import { loadProjectPolicy, resolveProjectSafety } from "./project-policy.js";

function value(args: string[], flag: string): string | undefined {
  const exact = args.indexOf(flag);
  if (exact >= 0) return args[exact + 1];
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function usage(): never {
  console.log(`Usage: bivy automation <command> [options]

Version-controlled, locally testable coding-agent automations.

Commands:
  list [--json]               List automations on the enrolled account
  trigger <id|config-key>     Start an automation run (alias: run)
  init [path]                 Write a safe starter .bivy/automations.yaml
  validate [path]             Parse and validate without network access
  plan [path] [--json]        Show triggers, routing, and effective safety
  test [path] --event <file>  Simulate an event and explain the first match
  apply [path] [--prune]      Encrypt instructions and reconcile the control plane

Default path: ${DEFAULT_AUTOMATION_CONFIG_PATH}
List, trigger, and apply require an enrolled node ('bivy setup'). Instructions
are encrypted on this machine before upload; the control plane receives
ciphertext only.`);
  process.exit(0);
}

function configPath(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--event") { i += 1; continue; }
    if (arg.startsWith("-")) continue;
    return path.resolve(arg);
  }
  return path.resolve(DEFAULT_AUTOMATION_CONFIG_PATH);
}

function load(file: string) {
  const result = parseAutomationConfig(fs.readFileSync(file, "utf8"));
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  if (!result.ok || !result.config) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  return result.config;
}

function appDataDir(): string {
  return process.env.BIVY_DATA_DIR ? path.resolve(process.env.BIVY_DATA_DIR) : path.join(process.env.HOME || "", ".bivy");
}

function effectiveSafety(entry: AutomationConfigEntry, file: string) {
  const node = readNodeConfig(appDataDir());
  const nodeBounded = resolveProjectSafety(node?.safety, entry.safety.sandbox, entry.safety.approval);
  return resolveProjectSafety(loadProjectPolicy(path.dirname(file))?.safety, nodeBounded.sandbox, nodeBounded.approval);
}

function assertAllowedRouting(entry: AutomationConfigEntry, file: string): void {
  const node = readNodeConfig(appDataDir());
  const allowed = loadProjectPolicy(path.dirname(file))?.routing;
  const agent = entry.routing.agent ?? node?.defaults?.agent ?? "pi";
  const model = entry.routing.model ?? node?.defaults?.model?.id;
  if (allowed?.allowedAgents?.length && !allowed.allowedAgents.includes(agent)) {
    throw new Error(`${entry.id} resolves to agent ${agent}, which repository policy does not allow`);
  }
  if (model && allowed?.allowedModels?.length && !allowed.allowedModels.includes(model)) {
    throw new Error(`${entry.id} resolves to model ${model}, which repository policy does not allow`);
  }
}

function relayConfig(appDir: string): { controlPlaneUrl: string; enrollmentToken: string; e2eKey?: string } {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(appDir, "relay.json"), "utf8")); }
  catch { throw new Error("Remote access is not configured. Run 'bivy setup' first."); }
  const o = raw as Record<string, unknown>;
  if (typeof o.controlPlaneUrl !== "string" || typeof o.enrollmentToken !== "string") throw new Error("relay.json is missing control-plane enrollment. Run 'bivy relay:setup'.");
  return { controlPlaneUrl: o.controlPlaneUrl.replace(/\/$/, ""), enrollmentToken: o.enrollmentToken, e2eKey: typeof o.e2eKey === "string" ? o.e2eKey : undefined };
}

async function request<T>(relay: ReturnType<typeof relayConfig>, pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.enrollmentToken}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${relay.controlPlaneUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `control plane returned ${res.status}`);
  return body as T;
}

function appliedInput(entry: AutomationConfigEntry, configOrder: number, nodeId: string, nodeName: string, roomKey: Buffer) {
  return {
    configKey: entry.id,
    configOrder,
    name: entry.name,
    enabled: entry.enabled,
    trigger: entry.trigger,
    templateCiphertext: `bivy-room-v1:${nodeId}:${seal(roomKey, entry.instructions)}`,
    schedule: entry.schedule,
    repo: entry.repo,
    repos: entry.repos,
    labels: entry.labels,
    on: entry.on,
    nodeLabel: `bivy/${entry.routing.node ?? nodeName}`,
    runtimeId: entry.routing.agent,
    model: entry.routing.model,
    ephemeral: entry.routing.ephemeral,
    approvalMode: entry.safety.approval,
    sandbox: entry.safety.sandbox,
    maxAttempts: entry.safety.maxAttempts,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "-h", "--help"].includes(command)) usage();

  if (command === "list") {
    const relay = relayConfig(appDataDir());
    const result = await request<{ automations: Array<{
      id: string; name: string; configKey?: string; enabled?: boolean; trigger?: string;
      nodeLabel?: string; nextRunAt?: string;
    }> }>(relay, "/node/automations");
    if (args.includes("--json")) {
      console.log(JSON.stringify(result.automations, null, 2));
      return;
    }
    if (result.automations.length === 0) {
      console.log("No automations.");
      return;
    }
    for (const automation of result.automations) {
      const ref = automation.configKey ? ` · key ${automation.configKey}` : "";
      console.log(`${automation.enabled === false ? "○" : "+"} ${automation.name} (${automation.trigger ?? "schedule"})`);
      console.log(`  id ${automation.id}${ref}`);
      if (automation.nodeLabel) console.log(`  node ${automation.nodeLabel.replace(/^bivy\//, "")}`);
      if (automation.nextRunAt) console.log(`  next ${automation.nextRunAt}`);
    }
    return;
  }

  if (command === "trigger" || command === "run") {
    const requested = args.find((arg) => !arg.startsWith("-"));
    if (!requested) throw new Error("Usage: bivy automation trigger <id|config-key> [--json]");
    const relay = relayConfig(appDataDir());
    const listed = await request<{ automations: Array<{ id: string; name: string; configKey?: string }> }>(relay, "/node/automations");
    const matches = listed.automations.filter((automation) => automation.id === requested || automation.configKey === requested);
    if (matches.length === 0) throw new Error(`Automation not found: ${requested}. Run 'bivy automation list' to see available automations.`);
    if (matches.length > 1) throw new Error(`Automation reference is ambiguous: ${requested}. Use its id instead.`);
    const automation = matches[0]!;
    const run = await request<{ id: string; status?: string }>(relay, `/node/automations/${encodeURIComponent(automation.id)}/run`, { method: "POST" });
    if (args.includes("--json")) console.log(JSON.stringify(run, null, 2));
    else {
      console.log(`Started ${automation.name}`);
      console.log(`  run ${run.id}`);
      if (run.status) console.log(`  status ${run.status}`);
    }
    return;
  }

  if (command === "init") {
    const file = configPath(args);
    if (fs.existsSync(file) && !args.includes("--force")) throw new Error(`${file} already exists (use --force to replace it)`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, STARTER_AUTOMATION_CONFIG, { flag: "w" });
    console.log(`Created ${path.relative(process.cwd(), file) || file}`);
    console.log("Review the repository, agent, and safety policy, then run:");
    console.log(`  bivy automation test ${path.relative(process.cwd(), file)} --event .bivy/event.yaml`);
    console.log(`  bivy automation apply ${path.relative(process.cwd(), file)}`);
    return;
  }

  const file = configPath(args);
  const config = load(file);
  if (command === "validate") {
    for (const entry of config.automations) assertAllowedRouting(entry, file);
    console.log(`Valid: ${config.automations.length} automation(s) in ${path.relative(process.cwd(), file) || file}`);
    return;
  }

  if (command === "plan") {
    const plan = config.automations.map((a) => {
      assertAllowedRouting(a, file);
      const safety = effectiveSafety(a, file);
      return {
      id: a.id, action: "reconcile", enabled: a.enabled, trigger: a.trigger,
      route: { node: a.routing.node ?? "applying node", agent: a.routing.agent ?? "node default", model: a.routing.model ?? "agent default", ephemeral: a.routing.ephemeral ?? false },
      safety: { approval: safety.approval, sandbox: safety.sandbox, requestedApproval: a.safety.approval, requestedSandbox: a.safety.sandbox, maxAttempts: a.safety.maxAttempts, checks: a.trigger === "schedule" || a.trigger === "webhook" || a.trigger === "github" || a.trigger === "linear" ? "project test/lint/typecheck when declared" : "project defaults" },
      workspace: a.repo ?? (a.repos?.length ? a.repos.join(", ") : "from event"),
    };
    });
    if (args.includes("--json")) console.log(JSON.stringify({ version: 1, plan }, null, 2));
    else {
      for (const item of plan) {
        console.log(`${item.enabled ? "+" : "○"} ${item.id} (${item.trigger})`);
        console.log(`  route   ${item.route.node} · ${item.route.agent} · ${item.route.model}${item.route.ephemeral ? " · ephemeral" : ""}`);
        console.log(`  safety  ${item.safety.sandbox} · approvals ${item.safety.approval} · at most ${item.safety.maxAttempts} attempt(s)`);
        console.log(`  checks  ${item.safety.checks}`);
      }
    }
    return;
  }

  if (command === "test") {
    const eventFile = value(args, "--event");
    if (!eventFile) throw new Error("--event <fixture.yaml|json> is required");
    for (const entry of config.automations) assertAllowedRouting(entry, file);
    const event = parseSimulationEvent(fs.readFileSync(path.resolve(eventFile), "utf8"));
    const result = simulateAutomation(config, event);
    for (const row of result.reasons) console.log(`${row.matched ? "✓" : "·"} ${row.id}: ${row.reason}`);
    if (!result.matched) { console.error("No automation matched."); process.exitCode = 2; return; }
    const a = result.matched;
    console.log(`\nWould run ${a.name}`);
    console.log(`  node: ${a.routing.node ?? "applying node"}`);
    console.log(`  agent: ${a.routing.agent ?? "node default"}`);
    const safety = effectiveSafety(a, file);
    console.log(`  sandbox: ${safety.sandbox}${safety.sandbox !== a.safety.sandbox ? ` (requested ${a.safety.sandbox}; restricted by policy)` : ""}`);
    console.log(`  approvals: ${safety.approval}${safety.approval !== a.safety.approval ? ` (requested ${a.safety.approval}; restricted by policy)` : ""}`);
    console.log(`  attempt limit: ${a.safety.maxAttempts}`);
    console.log("No run was created and no instructions were uploaded.");
    return;
  }

  if (command === "apply") {
    for (const entry of config.automations) assertAllowedRouting(entry, file);
    const appDir = appDataDir();
    const relay = relayConfig(appDir);
    const identity = NodeIdentity.load(appDir);
    const pairing = PairingStore.load(appDir, relay.e2eKey);
    const current = await request<{ automations: Array<{ configKey?: string }> }>(relay, "/node/automation-config");
    const wanted = new Set(config.automations.map((a) => a.id));
    let created = 0, updated = 0, removed = 0;
    for (const [configOrder, entry] of config.automations.entries()) {
      const exists = current.automations.some((a) => a.configKey === entry.id);
      if (entry.routing.node && entry.routing.node !== identity.name) {
        throw new Error(`${entry.id} targets node ${entry.routing.node}, but this node is ${identity.name}; run apply on the target node`);
      }
      const input = appliedInput(entry, configOrder, identity.nodeId, identity.name, pairing.roomKey());
      const bounded = effectiveSafety(entry, file);
      input.approvalMode = bounded.approval;
      input.sandbox = bounded.sandbox;
      const applied = await request<{ webhookUrl?: string; webhookSecret?: string }>(relay, `/node/automation-config/${encodeURIComponent(entry.id)}`, { method: "PUT", body: JSON.stringify(input) });
      if (exists) updated += 1; else created += 1;
      console.log(`${exists ? "~" : "+"} ${entry.id}`);
      if (applied.webhookSecret) {
        console.log(`  webhook: ${applied.webhookUrl ?? "created"}`);
        console.log(`  secret (shown once): ${applied.webhookSecret}`);
      }
    }
    if (args.includes("--prune")) {
      for (const entry of current.automations) {
        if (!entry.configKey || wanted.has(entry.configKey)) continue; // UI-managed definitions are never pruned.
        await request(relay, `/node/automation-config/${encodeURIComponent(entry.configKey)}`, { method: "DELETE" });
        console.log(`- ${entry.configKey}`);
        removed += 1;
      }
    }
    console.log(`Applied: ${created} created, ${updated} updated, ${removed} removed.`);
    return;
  }

  throw new Error(`Unknown automation command: ${command}`);
}

main().catch((error) => {
  console.error(`Automation error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
