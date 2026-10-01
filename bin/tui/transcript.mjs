// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// A session's history messages as transcript entries for `bivy tui`: what the
// user said, what the agent said, and one line per tool call. Agents shape
// their messages differently, so this reads content blocks by kind, not by agent.

const TEXT = new Set(["text", "output_text", "input_text"]);
const TOOL_USE = new Set(["tool_use", "toolCall", "tool_call", "server_tool_use"]);
// Harness notes some runtimes persist as user text; never shown as the user's words.
const META = /^\s*(?:\[Request interrupted by user|<(?:task-notification|system-reminder)[\s>/])/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => TEXT.has(b?.type)).map((b) => String(b.text ?? "")).join("\n");
}

/** A one-line summary of a tool call: its name and its most telling argument. */
export function toolSummary(block) {
  const name = String(block?.name ?? block?.toolName ?? "tool");
  const args = block?.input ?? block?.arguments ?? block?.args ?? {};
  const input = typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return { value: args }; } })() : args;
  const key = ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"].find((k) => typeof input?.[k] === "string");
  const detail = key ? input[key] : "";
  return detail ? `${name} ${detail.replace(/\s+/g, " ").trim()}` : name;
}

/** "plan · 2 of 4 done · <current step>" for a full plan update (the shapes
 *  @bivy/core plan.ts reads), or undefined. A partial `merge` update is skipped:
 *  the full list it amends is already shown. */
export function planSummary(block) {
  const input = block?.input ?? block?.arguments ?? {};
  if (!input || typeof input !== "object" || input.merge === true) return undefined;
  const list = ["todos", "plan", "entries", "items", "steps", "tasks"].map((k) => input[k]).find(Array.isArray);
  const steps = (list ?? []).filter((e) => e && typeof e === "object");
  if (!steps.length) return undefined;
  const status = (e) => String(e.status ?? e.state ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const text = (e) => String(e.content ?? e.step ?? e.text ?? e.title ?? e.subject ?? "").trim();
  const done = steps.filter((e) => ["completed", "complete", "done"].includes(status(e))).length;
  const current = steps.find((e) => ["inprogress", "active", "running"].includes(status(e)));
  return `plan · ${done} of ${steps.length} done${current && text(current) ? ` · ${text(current)}` : ""}`;
}

/** `[{ role: "user"|"agent"|"tool", text }]` from `session.history` messages. */
export function transcriptEntries(messages = []) {
  const entries = [];
  // Runtimes may repeat a tool call in later messages as it progresses; show it once.
  const seenTools = new Set();
  for (const msg of messages) {
    const role = String(msg?.role ?? "assistant").toLowerCase();
    if (role === "toolresult" || role === "tool_result" || role === "tool") continue;
    if (role === "user") {
      const text = textOf(msg.content).trim();
      if (text && !META.test(text)) entries.push({ role: "user", text });
      continue;
    }
    if (role === "system") continue;
    const blocks = Array.isArray(msg?.content) ? msg.content : [{ type: "text", text: textOf(msg?.content) }];
    for (const block of blocks) {
      if (TEXT.has(block?.type) && String(block.text ?? "").trim()) entries.push({ role: "agent", text: String(block.text).trim() });
      else if (TOOL_USE.has(block?.type)) {
        const id = block.id ?? block.toolCallId;
        if (id && seenTools.has(id)) continue;
        if (id) seenTools.add(id);
        const plan = planSummary(block);
        if (plan) {
          // One plan line per turn, showing the latest progress.
          const previous = entries.findLastIndex((e) => e.role === "user" || e.plan);
          if (previous >= 0 && entries[previous].plan) entries.splice(previous, 1);
          entries.push({ role: "tool", text: plan, plan: true });
        } else if (!/^(plan|todo_?write|update_?plan)$/i.test(String(block.name ?? ""))) {
          entries.push({ role: "tool", text: toolSummary(block) });
        }
      }
    }
  }
  return entries;
}
