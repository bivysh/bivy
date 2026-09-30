#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Agent-UX eval: give real agents the tasks in certification/agent-ux.json,
 * each in a fresh workspace, with nothing but Bivy's agent note to go on, and
 * score whether they used Bivy the way the task needed (src/certification/agent-ux.ts).
 *
 *   pnpm run eval:agent-ux -- --agents claude-code-sdk,codex-approvals [--tasks id,id]
 *     [--url http://127.0.0.1:4317] [--data-dir ~/.bivy] [--root /tmp/bivy-agent-ux]
 *     [--timeout 300] [--json results.json]
 *
 * It drives a running node over its API (a device token from BIVY_EVAL_TOKEN, or
 * none on a loopback-trusted host), answers question cards with each task's
 * `answer`, and reports, per agent and task: the checks, the time taken, how
 * many Bivy calls the agent made (the audit log's agent.call events), and the
 * `bivy` commands it tried that don't exist (agent-cli-misses.jsonl). Real
 * agents and models: it costs model usage and is not part of CI.
 * The workspace root must be inside the node's allowed workspace.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { countCardBlocks, scoreAgentUx, type AgentUxCheck, type AgentUxTask } from "../src/certification/agent-ux.js";

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const base = (opt("url", "http://127.0.0.1:4317") ?? "").replace(/\/+$/, "");
const dataDir = path.resolve(opt("data-dir", process.env.BIVY_DATA_DIR ?? path.join(os.homedir(), ".bivy"))!);
const root = path.resolve(opt("root", path.join(os.tmpdir(), "bivy-agent-ux"))!);
const timeoutMs = Number(opt("timeout", "300")) * 1000;
const agents = (opt("agents") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
const token = process.env.BIVY_EVAL_TOKEN;
const allTasks = (JSON.parse(fs.readFileSync(new URL("../certification/agent-ux.json", import.meta.url), "utf8")) as { tasks: AgentUxTask[] }).tasks;
const wanted = opt("tasks")?.split(",");
const tasks = wanted ? allTasks.filter((t) => wanted.includes(t.id)) : allTasks;
if (!agents.length || !tasks.length) {
  console.error("Usage: pnpm run eval:agent-ux -- --agents <id,id> [--tasks <id,id>] [--url …] [--data-dir …] [--root …] [--timeout s] [--json out.json]");
  process.exit(2);
}

const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${pathname}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname}: ${(data as { error?: string }).error ?? res.status}`);
  return data as T;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seedWorkspace(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd: dir });
}

function listFiles(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.name === ".git" ? []
    : entry.isDirectory() ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
}

function jsonl(file: string): Array<Record<string, unknown>> {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

interface HistoryEvent { isStreaming?: boolean; messages?: Array<{ role: string; content: unknown }> }

function lastReply(messages: HistoryEvent["messages"] = []): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (Array.isArray(last.content) ? last.content : []).map((b) => (b as { type?: string; text?: string }).type === "text" ? (b as { text: string }).text : "").join("");
}

async function runTask(agent: string, task: AgentUxTask, machine: string) {
  const dir = path.join(root, `${agent}-${task.id}-${Date.now().toString(36)}`);
  seedWorkspace(dir, task.files);
  const started = Date.now();
  const session = await api<{ id: string }>("POST", "/api/session", { agent, workspace: dir, name: `agent-ux ${task.id}` });
  let asked = false;
  const approvalsSeen: string[] = [];
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws${token ? `?access_token=${encodeURIComponent(token)}` : ""}`);
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type?: string; sessionId?: string; requestId?: string; questions?: Array<{ question: string; options: Array<{ label: string }> }>; approval?: { id: string; sessionId: string; toolName: string } };
    // Approval cards are recorded and declined: an eval never changes the account.
    if (msg.type === "approval.created" && msg.approval?.sessionId === session.id) {
      approvalsSeen.push(msg.approval.toolName);
      void api("POST", `/api/approvals/${encodeURIComponent(msg.approval.id)}/reject`, {}).catch(() => undefined);
      return;
    }
    if (msg.type !== "session.question" || msg.sessionId !== session.id || !msg.requestId) return;
    asked = true;
    const answers = Object.fromEntries((msg.questions ?? []).map((q) => [q.question, task.answer ?? q.options[0]?.label ?? "Go ahead"]));
    void api("POST", "/api/session/question/answer", { sessionId: session.id, requestId: msg.requestId, answers }).catch(() => undefined);
  });
  await new Promise((resolve) => { socket.once("open", resolve); socket.once("error", resolve); });
  await api("POST", "/api/session/prompt", { sessionId: session.id, text: task.prompt });
  // Done once it has answered and stayed idle across two polls.
  let history: HistoryEvent = {};
  let idle = 0;
  while (Date.now() - started < timeoutMs && idle < 2) {
    await sleep(3000);
    history = await api<HistoryEvent>("GET", `/api/session/history?sessionId=${encodeURIComponent(session.id)}`).catch(() => history);
    const answered = (history.messages ?? []).some((m) => m.role === "assistant");
    idle = answered && !history.isStreaming ? idle + 1 : 0;
  }
  socket.close();
  const timedOut = idle < 2;
  const checks: AgentUxCheck[] = scoreAgentUx(task.expect, {
    blocks: countCardBlocks(history.messages),
    asked,
    approvals: approvalsSeen,
    reply: lastReply(history.messages),
    files: listFiles(dir),
  }, { machine });
  const bivyCalls = jsonl(path.join(dataDir, "audit", "audit.jsonl")).filter((e) => e.kind === "agent.call" && e.session === session.id).length;
  const misses = jsonl(path.join(dataDir, "agent-cli-misses.jsonl")).filter((e) => e.session === session.id).map((e) => String(e.word));
  return { agent, task: task.id, sessionId: session.id, passed: !timedOut && checks.every((c) => c.passed), timedOut, seconds: Math.round((Date.now() - started) / 1000), checks, bivyCalls, misses };
}

const machine = (await api<{ name: string }>("GET", "/api/node/info")).name;
const results = [];
for (const agent of agents) {
  for (const task of tasks) {
    process.stderr.write(`${agent} · ${task.id} … `);
    const result = await runTask(agent, task, machine).catch((error: unknown) => ({ agent, task: task.id, passed: false, error: error instanceof Error ? error.message : String(error) }));
    process.stderr.write(`${result.passed ? "pass" : "FAIL"}\n`);
    results.push(result);
  }
}

console.log(`\n| Agent | Task | Result | Time | Bivy calls | Unknown commands | Failed checks |\n| --- | --- | --- | --- | --- | --- | --- |`);
for (const r of results) {
  const row = r as { agent: string; task: string; passed: boolean; error?: string; timedOut?: boolean; seconds?: number; bivyCalls?: number; misses?: string[]; checks?: AgentUxCheck[] };
  const failed = row.error ?? (row.timedOut ? "timed out" : row.checks?.filter((c) => !c.passed).map((c) => c.expectation).join("; ") ?? "");
  console.log(`| ${row.agent} | ${row.task} | ${row.passed ? "pass" : "fail"} | ${row.seconds ?? "-"}s | ${row.bivyCalls ?? "-"} | ${row.misses?.join(", ") || "-"} | ${failed || "-"} |`);
}
const passed = results.filter((r) => r.passed).length;
console.log(`\n${passed}/${results.length} passed on ${machine}.`);
const out = opt("json");
if (out) fs.writeFileSync(out, `${JSON.stringify({ machine, at: new Date().toISOString(), results }, null, 2)}\n`);
