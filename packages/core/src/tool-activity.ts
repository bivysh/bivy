// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Classification of streamed agent events into tool start/result/update, plus
// extraction of tool name/input/id across the many shapes different CLI adapters
// emit. Ported from public/app/tool-activity.js.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ToolCallDetail } from "./tool-format.js";

type AnyEvent = Record<string, any> | null | undefined;

export function normalizeEventType(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[.\-\s]+/g, "_");
}

export function eventKind(ev: AnyEvent): string {
  const type = normalizeEventType(ev?.type || ev?.event || ev?.kind || ev?.assistantMessageEvent?.type);
  if (!type) return "";
  if (/^(tool|function)_(call|use|start|execution_start|call_start|use_start)$/.test(type)) return "start";
  if (/^(tool|function)_(result|end|execution_end|call_end|use_end)$/.test(type)) return "result";
  if (/^(tool|function)_(update|progress|execution_update|delta)$/.test(type)) return "update";
  return type;
}

export function blockType(block: AnyEvent): string {
  return normalizeEventType(block?.type || block?.kind || block?.name);
}

export function isToolUseBlock(block: AnyEvent): boolean {
  const t = blockType(block);
  if (!t) return false;
  return (
    t === "tool" ||
    t === "tool_use" ||
    t === "toolcall" ||
    t === "tool_call" ||
    t === "function_call" ||
    t.endsWith("_tool_use") ||
    t.endsWith("_tool_call")
  );
}

export function isToolResultBlock(block: AnyEvent): boolean {
  const t = blockType(block);
  if (!t) return false;
  return (
    t === "tool_result" ||
    t === "toolresult" ||
    t === "function_result" ||
    t.endsWith("_tool_result") ||
    t.endsWith("_function_result")
  );
}

export function toolName(ev: AnyEvent): string {
  return String(
    ev?.toolName ||
      ev?.name ||
      ev?.tool?.name ||
      ev?.tool ||
      ev?.function?.name ||
      ev?.toolCall?.name ||
      ev?.call?.name ||
      "tool",
  ).toLowerCase();
}

export function toolInput(ev: AnyEvent): unknown {
  return (
    ev?.input ||
    ev?.toolInput ||
    ev?.args ||
    ev?.arguments ||
    ev?.parameters ||
    ev?.function?.arguments ||
    ev?.toolCall?.arguments ||
    ev?.toolCall?.input ||
    ev?.call?.input ||
    {}
  );
}

const DETAIL_KINDS = new Set(["shell", "read", "write", "edit", "search", "fetch", "plan"]);

/**
 * Read the node's normalized ToolCallDetail off a tool block/event, if present.
 * Returned untyped-but-validated (kind is one we know) so the caller can hand it
 * to formatTool; a missing or unrecognized shape returns undefined and the UI
 * falls back to its heuristic parse of the raw input.
 */
export function toolDetail(ev: AnyEvent): ToolCallDetail | undefined {
  const d = ev?.detail;
  if (d && typeof d === "object" && typeof d.kind === "string" && DETAIL_KINDS.has(d.kind)) {
    return d as ToolCallDetail;
  }
  return undefined;
}

export function toolCallId(ev: AnyEvent): string {
  return (
    ev?.toolCallId ||
    ev?.toolUseId ||
    ev?.tool_use_id ||
    ev?.callId ||
    ev?.id ||
    ev?.toolCall?.id ||
    ev?.call?.id ||
    ev?.function?.id ||
    ""
  );
}
