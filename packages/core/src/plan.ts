// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// An agent's plan (todo list) as one shape. Agents publish it three ways: a todo
// tool call (`todos: [{content, status}]`), Codex's `turn/plan/updated`
// (`plan: [{step, status}]`), and ACP's `plan` session update
// (`entries: [{content, status}]`). The shims forward the last two as a `plan`
// tool call, so every plan reaches the transcript as a tool input, and this
// module reads any of them. Spellings are table rows, not per-agent code.

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanEntry {
  text: string;
  status: PlanStatus;
  id?: string;
}

const LIST_KEYS = ["todos", "plan", "entries", "items", "steps", "tasks"];
const TEXT_KEYS = ["content", "step", "text", "title", "subject", "description", "task"];
const STATUS: Record<string, PlanStatus> = {
  pending: "pending", todo: "pending", notstarted: "pending", open: "pending",
  inprogress: "in_progress", active: "in_progress", running: "in_progress", doing: "in_progress", current: "in_progress", started: "in_progress",
  completed: "completed", complete: "completed", done: "completed", finished: "completed", success: "completed",
  cancelled: "cancelled", canceled: "cancelled", skipped: "cancelled", abandoned: "cancelled",
};

function planStatus(value: unknown): PlanStatus | undefined {
  return STATUS[String(value ?? "").toLowerCase().replace(/[^a-z]/g, "")];
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * The plan a tool input carries, or undefined when it holds no list of steps.
 * `merge` marks a partial update (entries keyed by id, text may be missing) that
 * applies on top of the previous plan rather than replacing it.
 */
export function planUpdateOf(input: unknown): { entries: Array<Partial<PlanEntry>>; merge: boolean } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  const list = LIST_KEYS.map((key) => o[key]).find(Array.isArray);
  if (!list?.length) return undefined;
  const entries: Array<Partial<PlanEntry>> = [];
  for (const raw of list) {
    if (typeof raw === "string") { entries.push({ text: raw, status: "pending" }); continue; }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = firstString(item, TEXT_KEYS);
    const status = planStatus(item.status ?? item.state);
    const id = item.id ?? item.taskId;
    entries.push({ ...(text ? { text } : {}), ...(status ? { status } : {}), ...(id != null && id !== "" ? { id: String(id) } : {}) });
  }
  const merge = o.merge === true;
  if (!merge && !entries.some((e) => e.text)) return undefined;
  return { entries, merge };
}

/** Apply one update to the previous plan: replace it, or merge entries by id. */
export function applyPlanUpdate(previous: PlanEntry[], update: { entries: Array<Partial<PlanEntry>>; merge: boolean }): PlanEntry[] {
  if (!update.merge) {
    return update.entries.filter((e) => e.text).map((e) => ({ text: e.text!, status: e.status ?? "pending", ...(e.id ? { id: e.id } : {}) }));
  }
  const next = previous.map((e) => ({ ...e }));
  for (const change of update.entries) {
    const existing = change.id ? next.find((e) => e.id === change.id) : undefined;
    if (existing) {
      if (change.text) existing.text = change.text;
      if (change.status) existing.status = change.status;
    } else if (change.text) {
      next.push({ text: change.text, status: change.status ?? "pending", ...(change.id ? { id: change.id } : {}) });
    }
  }
  return next;
}

/** The plan after a sequence of plan tool inputs, oldest first. */
export function latestPlan(inputs: readonly unknown[]): PlanEntry[] {
  let plan: PlanEntry[] = [];
  for (const input of inputs) {
    const update = planUpdateOf(input);
    if (update) plan = applyPlanUpdate(plan, update);
  }
  return plan;
}

const CHECKLIST: Record<PlanStatus, { box: string; note: string }> = {
  completed: { box: "[x]", note: "" },
  in_progress: { box: "[ ]", note: " (in progress)" },
  pending: { box: "[ ]", note: "" },
  cancelled: { box: "[ ]", note: " (cancelled)" },
};

/** A plan as a Markdown checklist, for prompts and transcript files. */
export function planChecklist(plan: readonly PlanEntry[]): string {
  return plan.map((e) => `- ${CHECKLIST[e.status].box} ${e.text}${CHECKLIST[e.status].note}`).join("\n");
}
