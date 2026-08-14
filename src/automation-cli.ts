#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DEFAULT_AUTOMATION_CONFIG_PATH, STARTER_AUTOMATION_CONFIG, parseAutomationConfig, parseSimulationEvent, simulateAutomation, type AutomationConfig, type AutomationConfigEntry } from "./automation-config.js";
import { findOverlaps, gateFromChecks, runPreflightChecks, type PreflightSignals } from "./automation/index.js";
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

Run commands (normally invoked as 'bivy runs ...'):
  start <instructions>          Queue definition-free unattended work
  list [--limit <n>] [--json]  List recent Runs and their current status
  status <id> [--json]         Inspect one Run's status, evidence, and outputs
  wait <id> [options]          Poll until the Run reaches a terminal status

Start flags:
  --name <title>  --repo <owner/name>  --agent <id>  --model <id>
  --approval <mode>  --sandbox <tier>  --max-attempts <1-10>  --json
  Pass '-' as the instructions to read them from stdin.
Wait flags: --interval <seconds> (default 2), --timeout <seconds> (default 3600),
--json. Wait exits 0 for succeeded, 1 for failed/cancelled, and 2 on timeout.

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

type RunSummary = {
  id: string;
  title: string;
  status: "pending" | "claimed" | "running" | "waiting" | "needs_attention" | "succeeded" | "failed" | "cancelled";
  triggerKind?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  maxAttempts?: number;
  runtimeId?: string;
  model?: string;
  output?: { sessionId?: string; branch?: string; prUrl?: string; artifactUrl?: string; failure?: string };
  checks?: Array<{ name: string; status: string; exitCode?: number }>;
  events?: Array<{ at: string; kind: string; summary: string }>;
};

const TERMINAL_RUN_STATUSES = new Set<RunSummary["status"]>(["succeeded", "failed", "cancelled"]);

function runLine(run: RunSummary): string {
  const attempt = run.attempt && run.attempt > 1 ? ` · attempt ${run.attempt}` : "";
  return `${run.status.padEnd(15)} ${run.id}  ${run.title}${attempt}`;
}

function appDataDir(): string {
  return process.env.BIVY_DATA_DIR ? path.resolve(process.env.BIVY_DATA_DIR) : path.join(process.env.HOME || "", ".bivy");
}

function effectiveSafety(entry: AutomationConfigEntry, file: string) {
  const node = readNodeConfig(appDataDir());
  const nodeBounded = resolveProjectSafety(node?.safety, entry.safety.sandbox, entry.safety.approval);
  return resolveProjectSafety(loadProjectPolicy(path.dirname(file))?.safety, nodeBounded.sandbox, nodeBounded.approval);
}

/** Print any overlap/shadow findings across the whole config, in first-match
 *  evaluation (file) order. Never blocks — this is informational, the same
 *  contract the control-plane simulate endpoint and PWA Test event workflow
 *  explain (see docs/automation-evaluator.md). */
function printOverlapWarnings(config: AutomationConfig): void {
  const findings = findOverlaps(config.automations);
  if (!findings.length) return;
  console.log("\nOverlap warnings:");
  for (const finding of findings) {
    const icon = finding.kind === "shadowed" ? "⚠" : "·";
    console.log(`  ${icon} ${finding.detail}`);
  }
}

/**
 * Signals `bivy automation test` can gather without any network access: the
 * effective (policy-bounded) sandbox/approval vs what the entry requested, and
 * whether an agent/model was explicitly pinned. Source connection, repository
 * access, the encrypted-instruction key's holder, the assigned machine's
 * liveness, and quota all require the control plane and are reported
 * "skipped" here — `bivy automation apply` and the PWA Test event workflow
 * are where those show up with real signal.
 */
function gatherLocalPreflightSignals(entry: AutomationConfigEntry, file: string): PreflightSignals {
  const effective = effectiveSafety(entry, file);
  const explicit = Boolean(entry.routing.agent || entry.routing.model);
  return {
    sandboxPolicy: {
      requestedApproval: entry.safety.approval,
      requestedSandbox: entry.safety.sandbox,
      effectiveApproval: effective.approval,
      effectiveSandbox: effective.sandbox,
      // parseAutomationConfig already hard-rejects this combo at load time
      // (config would never have reached `test`), but the checklist evaluates
      // the same unsafeCombo condition as every other caller for consistency.
      unsafeCombo: effective.approval === "autonomous" && effective.sandbox === "danger-full-access" && !entry.safety.allowDangerous,
    },
    // Whether credentials are actually ready can only be answered by the node
    // that will run this (or the control plane's record of it) — not from a
    // config file. Report "explicit" so an unset agent/model is skipped
    // outright rather than shown as an unresolved unknown.
    agentModelCredentials: explicit
      ? {
        agent: entry.routing.agent,
        model: entry.routing.model,
        explicit,
        detail: "Credential readiness can't be checked offline; run 'bivy automation apply' or check the assigned node's Models & providers screen.",
      }
      : undefined,
  };
}

/** Print the preflight checklist for the automation that matched a test fixture.
 *  Returns the save/run gate so the caller can decide the exit code. */
function printPreflightChecklist(entry: AutomationConfigEntry, file: string): ReturnType<typeof gateFromChecks> {
  const results = runPreflightChecks(gatherLocalPreflightSignals(entry, file));
  console.log("\nPreflight checklist:");
  for (const check of results) {
    if (check.severity === "skipped") continue;
    const icon = check.severity === "ok" ? "✓" : check.severity === "block" ? "✗" : check.severity === "warn" ? "⚠" : "·";
    console.log(`  ${icon} ${check.label}: ${check.detail}`);
  }
  return gateFromChecks(results);
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
    allowDangerous: entry.safety.allowDangerous,
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

  if (command === "runs-list") {
    const relay = relayConfig(appDataDir());
    const rawLimit = Number(value(args, "--limit") ?? 30);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 30;
    const result = await request<{ runs: RunSummary[] }>(relay, `/node/automation-runs?limit=${limit}`);
    if (args.includes("--json")) console.log(JSON.stringify(result.runs, null, 2));
    else if (!result.runs.length) console.log("No Runs.");
    else for (const run of result.runs) console.log(runLine(run));
    return;
  }

  if (command === "runs-status" || command === "runs-wait") {
    const id = args.find((arg, index) => !arg.startsWith("-") && (index === 0 || !["--interval", "--timeout"].includes(args[index - 1]!)));
    if (!id) throw new Error(`Usage: bivy runs ${command === "runs-wait" ? "wait" : "status"} <id> [--json]`);
    const relay = relayConfig(appDataDir());
    if (command === "runs-status") {
      const run = await request<RunSummary>(relay, `/node/automation-runs/${encodeURIComponent(id)}`);
      if (args.includes("--json")) console.log(JSON.stringify(run, null, 2));
      else {
        console.log(runLine(run));
        if (run.output?.sessionId) console.log(`  session ${run.output.sessionId}`);
        if (run.output?.branch) console.log(`  branch ${run.output.branch}`);
        if (run.output?.prUrl) console.log(`  pull request ${run.output.prUrl}`);
        if (run.output?.failure) console.log(`  failure ${run.output.failure}`);
      }
      return;
    }
    const intervalSeconds = Number(value(args, "--interval") ?? 2);
    const timeoutSeconds = Number(value(args, "--timeout") ?? 3600);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error("--interval must be a positive number of seconds");
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds");
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let previous = "";
    while (true) {
      const run = await request<RunSummary>(relay, `/node/automation-runs/${encodeURIComponent(id)}`);
      if (!args.includes("--json") && run.status !== previous) console.error(runLine(run));
      previous = run.status;
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        if (args.includes("--json")) console.log(JSON.stringify(run, null, 2));
        process.exitCode = run.status === "succeeded" ? 0 : 1;
        return;
      }
      if (Date.now() >= deadline) {
        if (args.includes("--json")) console.log(JSON.stringify({ id: run.id, status: run.status, timedOut: true }, null, 2));
        else console.error(`Timed out waiting for Run ${run.id} (${run.status}).`);
        process.exitCode = 2;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
    }
  }

  if (command === "start-run") {
    if (args.includes("-h") || args.includes("--help")) usage();
    const valuedFlags = new Set(["--name", "--repo", "--agent", "--model", "--approval", "--sandbox", "--max-attempts"]);
    const positional: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (valuedFlags.has(arg)) { i += 1; continue; }
      if (arg.startsWith("--") && arg.includes("=")) continue;
      if (arg === "--json") continue;
      positional.push(arg);
    }
    let instructions = positional.join(" ").trim();
    if (instructions === "-") instructions = fs.readFileSync(0, "utf8").trim();
    if (!instructions) throw new Error("instructions are required (or pass '-' to read stdin)");
    const appDir = appDataDir();
    const relay = relayConfig(appDir);
    const identity = NodeIdentity.load(appDir);
    const pairing = PairingStore.load(appDir, relay.e2eKey);
    const approvalMode = value(args, "--approval") ?? "risky";
    const sandbox = value(args, "--sandbox") ?? "workspace-write";
    const maxAttempts = Number(value(args, "--max-attempts") ?? 2);
    const title = (value(args, "--name") ?? instructions.split(/\r?\n/, 1)[0] ?? "One-off Run").slice(0, 120);
    const created = await request<{ id: string; status: string }>(relay, "/node/automation-runs", {
      method: "POST",
      body: JSON.stringify({
        title,
        body: `bivy-room-v1:${identity.nodeId}:${seal(pairing.roomKey(), instructions)}`,
        repo: value(args, "--repo"),
        runtimeId: value(args, "--agent"),
        model: value(args, "--model"),
        approvalMode,
        sandbox,
        maxAttempts,
      }),
    });
    if (args.includes("--json")) console.log(JSON.stringify(created, null, 2));
    else {
      console.log(`Queued Run ${created.id} on ${identity.name}.`);
      console.log(`Status: ${created.status}`);
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
    printOverlapWarnings(config);
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
    printOverlapWarnings(config);
    if (!result.matched) { console.error("No automation matched."); process.exitCode = 2; return; }
    const a = result.matched;
    console.log(`\nWould run ${a.name}`);
    console.log(`  node: ${a.routing.node ?? "applying node"}`);
    console.log(`  agent: ${a.routing.agent ?? "node default"}`);
    const safety = effectiveSafety(a, file);
    console.log(`  sandbox: ${safety.sandbox}${safety.sandbox !== a.safety.sandbox ? ` (requested ${a.safety.sandbox}; restricted by policy)` : ""}`);
    console.log(`  approvals: ${safety.approval}${safety.approval !== a.safety.approval ? ` (requested ${a.safety.approval}; restricted by policy)` : ""}`);
    console.log(`  attempt limit: ${a.safety.maxAttempts}`);
    const gate = printPreflightChecklist(a, file);
    console.log("\nNo run was created and no instructions were uploaded.");
    if (gate.blocked) {
      console.error(`\nBlocked: ${gate.blockingChecks.map((c) => c.label).join(", ")}`);
      process.exitCode = 2;
    }
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
