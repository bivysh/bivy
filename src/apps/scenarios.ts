// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";

/** Scenarios: named starting points for a live app, one JSON file each in the
 * project. Opening one puts the viewer's preview in that state (a page, steps
 * taken in it, responses the gateway simulates) and Reset puts it back. Every
 * layer here works per viewer and needs nothing from the app itself, so it
 * works for any framework and any agent. See docs/apps.md#scenarios. */
export const SCENARIO_DIR = path.join(".bivy", "scenarios");
const MAX_FILES = 100;
const MAX_BYTES = 64 * 1024;
const MAX_STEPS = 50;
const MAX_RULES = 20;
const MAX_CHAIN = 5;
const MAX_DELAY_MS = 30_000;
const MAX_WAIT_MS = 10_000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export type ScenarioStep = { click: string } | { fill: string; with: string } | { press: string } | { wait: string | number };
export interface NetworkRule { method?: string; path: string; status?: number; json?: unknown; body?: string; delayMs?: number; offline?: boolean }
export interface Scenario {
  id: string; name: string; description?: string; view?: string; from?: string; open?: string; fresh?: boolean;
  steps: ScenarioStep[]; network: NetworkRule[];
  /** When its file last changed: newer than the app means "new in this session". */
  changedAt: number;
}
/** A file that couldn't be read as a scenario, and why: said to the agent and shown on its tile. */
export interface ScenarioProblem { id: string; file: string; error: string }
/** One page and the steps taken on it. A `from` chain is a list of these. */
export interface ScenarioStage { open?: string; steps: ScenarioStep[] }
/** What opening a scenario does, resolved through its `from` chain. */
export interface ScenarioPlan { id: string; name: string; fresh: boolean; stages: ScenarioStage[]; network: NetworkRule[]; simulated?: string }
export interface ScenarioSummary { id: string; name: string; description?: string; open: string; steps: number; simulated?: string; fresh?: boolean; isNew?: boolean; error?: string }

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be text of 1–${max} characters.`);
  return value.trim();
};
const page = (value: unknown, label: string): string => {
  const at = text(value, label, 2048);
  if (!at.startsWith("/") || at.startsWith("//")) throw new Error(`${label} must be a path that starts with /.`);
  return at;
};

/** Each step kind, as a row: the key that names it and how its value is read.
 *  Adding a kind of step means adding a row here and a case in the page's runner. */
const STEPS: { key: string; read(raw: Record<string, unknown>): ScenarioStep }[] = [
  { key: "click", read: (raw) => ({ click: text(raw.click, "click", 300) }) },
  { key: "fill", read: (raw) => {
    if (typeof raw.with !== "string" || raw.with.length > 2000) throw new Error("fill needs \"with\": the text to put in the field (up to 2,000 characters).");
    return { fill: text(raw.fill, "fill", 300), with: raw.with };
  } },
  { key: "press", read: (raw) => ({ press: text(raw.press, "press", 40) }) },
  { key: "wait", read: (raw) => {
    if (typeof raw.wait === "number") {
      if (!Number.isFinite(raw.wait) || raw.wait < 0 || raw.wait > MAX_WAIT_MS) throw new Error(`wait takes a selector, or milliseconds up to ${MAX_WAIT_MS}.`);
      return { wait: Math.round(raw.wait) };
    }
    return { wait: text(raw.wait, "wait", 300) };
  } },
];
function readStep(raw: unknown, index: number): ScenarioStep {
  const step = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const kind = STEPS.find((row) => row.key in step);
  if (!kind) throw new Error(`Step ${index + 1} must be one of: ${STEPS.map((row) => row.key).join(", ")}.`);
  try { return kind.read(step); } catch (error) { throw new Error(`Step ${index + 1}: ${(error as Error).message}`); }
}

/** "POST /api/payments*" or "/api/orders": an optional method, then a path where * matches anything. */
function readRule(raw: unknown, index: number): NetworkRule {
  const label = `Network rule ${index + 1}`;
  const rule = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!rule) throw new Error(`${label} must be an object.`);
  const [first, second, ...extra] = text(rule.match, `${label} "match"`, 300).split(/\s+/);
  const method = second ? first!.toUpperCase() : undefined;
  if (extra.length || (method && !METHODS.includes(method))) throw new Error(`${label}: "match" is an optional method and a path, like "POST /api/payments*".`);
  const result: NetworkRule = { ...(method ? { method } : {}), path: page(second ?? first, `${label} path`) };
  if (rule.status !== undefined) {
    if (!Number.isInteger(rule.status) || (rule.status as number) < 200 || (rule.status as number) > 599) throw new Error(`${label}: status must be an HTTP status from 200 to 599.`);
    result.status = rule.status as number;
  }
  if (rule.json !== undefined) result.json = rule.json;
  if (rule.body !== undefined) {
    if (typeof rule.body !== "string" || rule.body.length > 32_000) throw new Error(`${label}: body must be text up to 32,000 characters.`);
    result.body = rule.body;
  }
  if (result.json !== undefined && result.body !== undefined) throw new Error(`${label}: use json or body, not both.`);
  if (rule.delayMs !== undefined) {
    if (typeof rule.delayMs !== "number" || !Number.isFinite(rule.delayMs) || rule.delayMs < 0 || rule.delayMs > MAX_DELAY_MS) throw new Error(`${label}: delayMs must be 0–${MAX_DELAY_MS}.`);
    result.delayMs = Math.round(rule.delayMs);
  }
  if (rule.offline !== undefined && rule.offline !== true) throw new Error(`${label}: offline can only be true.`);
  if (rule.offline) {
    if (result.status !== undefined || result.json !== undefined || result.body !== undefined) throw new Error(`${label}: an offline rule sends no response, so it has no status, json or body.`);
    result.offline = true;
  }
  if (!result.offline && result.status === undefined && result.json === undefined && result.body === undefined && !result.delayMs) throw new Error(`${label} does nothing: give it a status, json, body, delayMs or offline.`);
  return result;
}

/** One scenario file's contents. Throws a message meant for whoever wrote it. */
export function readScenario(id: string, raw: unknown, changedAt = 0): Scenario {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A scenario is a JSON object with at least a \"name\".");
  const input = raw as Record<string, unknown>;
  const known = new Set(["$schema", "name", "description", "view", "from", "open", "fresh", "steps", "network"]);
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")}. A scenario has: name, description, view, from, open, fresh, steps, network.`);
  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > MAX_STEPS)) throw new Error(`steps must be a list of up to ${MAX_STEPS} steps.`);
  if (input.network !== undefined && (!Array.isArray(input.network) || input.network.length > MAX_RULES)) throw new Error(`network must be a list of up to ${MAX_RULES} rules.`);
  if (input.fresh !== undefined && typeof input.fresh !== "boolean") throw new Error("fresh must be true or false.");
  const from = input.from === undefined ? undefined : text(input.from, "from", 64);
  if (from !== undefined && !ID.test(from)) throw new Error("from names another scenario by its file name, without .json.");
  if (from === id) throw new Error("A scenario can't start from itself.");
  return {
    id, name: text(input.name, "name", 80), changedAt,
    ...(input.description === undefined ? {} : { description: text(input.description, "description", 200) }),
    ...(input.view === undefined ? {} : { view: text(input.view, "view", 100) }),
    ...(from ? { from } : {}),
    ...(input.open === undefined ? {} : { open: page(input.open, "open") }),
    ...(input.fresh ? { fresh: true } : {}),
    steps: ((input.steps as unknown[] | undefined) ?? []).map(readStep),
    network: ((input.network as unknown[] | undefined) ?? []).map(readRule),
  };
}

/** Every scenario file in a workspace. Files are read fresh each time (there
 * are few, and an agent may have just written one). A file that can't be read
 * is a problem to report, never a reason to hide the others. */
export function loadScenarios(workspace: string): { scenarios: Scenario[]; problems: ScenarioProblem[] } {
  const scenarios: Scenario[] = [];
  const problems: ScenarioProblem[] = [];
  const dir = path.join(workspace, SCENARIO_DIR);
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return { scenarios, problems };
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_FILES);
  } catch { return { scenarios, problems }; }
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const file = path.join(SCENARIO_DIR, name);
    try {
      if (!ID.test(id)) throw new Error("Name the file with lowercase letters, digits and dashes, like checkout-api-down.json.");
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile()) throw new Error("Not a regular file.");
      if (stat.size > MAX_BYTES) throw new Error("Larger than 64 KiB.");
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch (error) { throw new Error(`Not valid JSON: ${(error as Error).message}`); }
      scenarios.push(readScenario(id, raw, stat.mtimeMs));
    } catch (error) { problems.push({ id, file, error: (error as Error).message }); }
  }
  return { scenarios, problems };
}

/** The scenarios that belong to one view: those naming it (or its app), and those naming none. */
export function scenariosFor<T extends { view?: string }>(list: T[], app: string, view: string): T[] {
  const names = [app.toLowerCase(), view.toLowerCase()];
  return list.filter((scenario) => !scenario.view || names.includes(scenario.view.toLowerCase()));
}

/** In words, for the pill: "POST /api/payments* → 503". */
export function describeRule(rule: NetworkRule): string {
  const outcome = rule.offline ? "offline" : rule.status ?? (rule.json !== undefined || rule.body !== undefined ? 200 : `+${rule.delayMs}ms`);
  return `${rule.method ? `${rule.method} ` : ""}${rule.path} → ${outcome}`;
}
function simulated(rules: NetworkRule[]): string | undefined {
  if (!rules.length) return undefined;
  return describeRule(rules[0]!) + (rules.length > 1 ? ` (+${rules.length - 1} more)` : "");
}

/** Resolves a scenario through its `from` chain: the base's page and steps
 * first, then each one built on it; network rules nearest first, so a scenario
 * overrides what it builds on. */
export function planScenario(list: Scenario[], id: string): ScenarioPlan {
  const chain: Scenario[] = [];
  for (let at: string | undefined = id; at;) {
    const scenario = list.find((item) => item.id === at);
    if (!scenario) throw new Error(at === id ? `No scenario called "${id}".` : `"${chain.at(-1)!.id}" starts from "${at}", which doesn't exist or can't be read.`);
    if (chain.some((item) => item.id === at)) throw new Error(`"${id}" starts from itself through ${chain.map((item) => item.id).join(" → ")}.`);
    chain.push(scenario);
    if (chain.length > MAX_CHAIN) throw new Error(`"${id}" builds on more than ${MAX_CHAIN} scenarios.`);
    at = scenario.from;
  }
  const order = [...chain].reverse();
  const network = chain.flatMap((scenario) => scenario.network);
  return {
    id, name: chain[0]!.name, fresh: order.some((scenario) => scenario.fresh === true),
    stages: order.map((scenario, index) => ({ ...(scenario.open ? { open: scenario.open } : index === 0 ? { open: "/" } : {}), steps: scenario.steps })),
    network, ...(simulated(network) ? { simulated: simulated(network) } : {}),
  };
}

/** What a list or tile shows. `since`: the app's creation; files changed after it are new. */
export function summarize(list: Scenario[], problems: ScenarioProblem[], since: number): ScenarioSummary[] {
  const rows: ScenarioSummary[] = list.map((scenario) => {
    try {
      const plan = planScenario(list, scenario.id);
      return {
        id: scenario.id, name: scenario.name, ...(scenario.description ? { description: scenario.description } : {}),
        open: [...plan.stages].reverse().find((stage) => stage.open)?.open ?? "/",
        steps: plan.stages.reduce((sum, stage) => sum + stage.steps.length, 0),
        ...(plan.simulated ? { simulated: plan.simulated } : {}), ...(plan.fresh ? { fresh: true } : {}),
        ...(scenario.changedAt > since ? { isNew: true } : {}),
      };
    } catch (error) { return { id: scenario.id, name: scenario.name, open: "/", steps: 0, error: (error as Error).message }; }
  });
  return [...rows, ...problems.map((problem) => ({ id: problem.id, name: problem.id, open: "/", steps: 0, error: problem.error }))];
}

/** The rule a request meets, if any: the first whose method and path match. */
export function matchRule(rules: NetworkRule[], method: string | undefined, url: string): NetworkRule | undefined {
  const [pathname] = url.split("?");
  return rules.find((rule) => (!rule.method || rule.method === (method ?? "GET").toUpperCase())
    && new RegExp(`^${rule.path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(rule.path.includes("?") ? url : pathname!));
}
