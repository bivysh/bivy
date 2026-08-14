// SPDX-License-Identifier: AGPL-3.0-only
// Pure live transcript/tool reducer. It owns no store, transport, cache, clock,
// or persistence identity; the SessionStore interprets the returned commands.

import type { PromptAttachment, ServerEvent } from "./protocol.js";
import { toHtml } from "./markdown.js";
import { eventKind, toolCallId, toolDetail, toolInput, toolName } from "./tool-activity.js";
import { contentThinking, contentToText, toolEntriesFromContent } from "./store-render.js";
import { humanizeError, looksLikeAgentError } from "./store-errors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TranscriptFoldTool {
  callId: string; name: string; input: unknown; status: "running" | "done"; result?: string; detail?: unknown;
}
export interface TranscriptFoldEntry {
  id: string; role: "user" | "assistant" | "system" | "thinking" | "error"; text: string;
  html?: string; tool?: TranscriptFoldTool; streaming?: boolean; attachments?: PromptAttachment[];
  imageRefs?: Record<string, unknown>;
}
export interface TranscriptDraftValue {
  assistantId: string | null; thinkingId: string | null; finalized: boolean;
  thinkingText: string; sawThinking: boolean; pendingText: string;
  committedText: string; committedThinking: string;
}
export interface BufferedAgentAttachment { attachment: PromptAttachment; caption: string }
export interface TranscriptFoldValue {
  transcript: TranscriptFoldEntry[];
  draft: TranscriptDraftValue;
  pendingAgentAttachments: BufferedAgentAttachment[];
  working: boolean;
  workingLabel: string;
}
export type TranscriptFoldCommand =
  | { kind: "cache-inline-image"; url: string; ref: unknown }
  | { kind: "remember-agent-attachments" }
  | { kind: "turn-settled" };
export interface TranscriptFoldResult {
  handled: boolean;
  value: TranscriptFoldValue;
  commands: TranscriptFoldCommand[];
}

export function freshTranscriptDraft(finalized = true): TranscriptDraftValue {
  return { assistantId: null, thinkingId: null, finalized, thinkingText: "", sawThinking: false, pendingText: "", committedText: "", committedThinking: "" };
}

function cloneValue(value: TranscriptFoldValue): TranscriptFoldValue {
  return { ...value, transcript: [...value.transcript], draft: { ...value.draft }, pendingAgentAttachments: [...value.pendingAgentAttachments] };
}

function idFor(entries: readonly TranscriptFoldEntry[]): string {
  let n = entries.length + 1;
  const ids = new Set(entries.map((entry) => entry.id));
  while (ids.has(`live-${n}`)) n += 1;
  return `live-${n}`;
}

function append(value: TranscriptFoldValue, entry: Omit<TranscriptFoldEntry, "id">): TranscriptFoldEntry {
  const full = { id: idFor(value.transcript), ...entry } as TranscriptFoldEntry;
  value.transcript.push(full);
  return full;
}
function replace(value: TranscriptFoldValue, id: string, patch: Partial<TranscriptFoldEntry>): void {
  value.transcript = value.transcript.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
}
function remove(value: TranscriptFoldValue, id: string): void {
  value.transcript = value.transcript.filter((entry) => entry.id !== id);
}
function setWorking(value: TranscriptFoldValue, label: string): void { value.working = true; value.workingLabel = label; }

function upsertDraft(value: TranscriptFoldValue, which: "assistant" | "thinking", text: string, finalize: boolean): void {
  const role = which === "assistant" ? "assistant" : "thinking";
  const field = which === "assistant" ? "assistantId" : "thinkingId";
  const html = role === "assistant" && finalize ? toHtml(text) : undefined;
  let id = value.draft[field];
  if (!id) {
    const entry = append(value, { role, text, html, streaming: !finalize });
    id = entry.id;
    value.draft[field] = id;
  } else replace(value, id, { text, html, streaming: !finalize });
  if (finalize) value.draft[field] = null;
}
function finishDrafts(value: TranscriptFoldValue): void {
  if (value.draft.assistantId) replace(value, value.draft.assistantId, { streaming: false });
  if (value.draft.thinkingId) replace(value, value.draft.thinkingId, { streaming: false });
  value.draft.assistantId = null; value.draft.thinkingId = null;
}
function commitThinking(value: TranscriptFoldValue): void {
  const draft = value.draft;
  if (!draft.sawThinking) return;
  const tail = (draft.thinkingText.startsWith(draft.committedThinking) ? draft.thinkingText.slice(draft.committedThinking.length) : draft.thinkingText).trim();
  if (!tail) return;
  draft.committedThinking = draft.thinkingText; draft.thinkingId = null;
  upsertDraft(value, "thinking", tail, true);
}
function proseTail(draft: TranscriptDraftValue): string {
  return (draft.pendingText.startsWith(draft.committedText) ? draft.pendingText.slice(draft.committedText.length) : draft.pendingText).trim();
}
function commitProse(value: TranscriptFoldValue): void {
  const tail = proseTail(value.draft);
  if (!tail) return;
  value.draft.committedText = value.draft.pendingText;
  if (looksLikeAgentError(tail)) {
    if (value.draft.assistantId) { remove(value, value.draft.assistantId); value.draft.assistantId = null; }
    append(value, { role: "error", text: humanizeError(tail) });
  } else upsertDraft(value, "assistant", tail, true);
}
function previewProse(value: TranscriptFoldValue): void {
  const tail = proseTail(value.draft); if (tail) upsertDraft(value, "assistant", tail, false);
}
function eventThinkingDelta(event: any): { kind: "full" | "delta" | "none"; text: string } {
  const inner = event?.assistantMessageEvent;
  if (inner?.type === "thinking_delta" && typeof inner.delta === "string") return { kind: "delta", text: inner.delta };
  if (inner?.type === "thinking_end" && typeof inner.content === "string") return { kind: "full", text: inner.content };
  return { kind: "none", text: "" };
}
function resolveThinking(event: any, block: string, draft: TranscriptDraftValue): string {
  if (block) draft.thinkingText = block;
  else {
    const delta = eventThinkingDelta(event);
    if (delta.kind === "delta") draft.thinkingText += delta.text;
    else if (delta.kind === "full") draft.thinkingText = delta.text;
  }
  return draft.thinkingText.trim();
}
function mergeInput(previous: unknown, next: unknown): unknown {
  if (previous && next && typeof previous === "object" && typeof next === "object" && !Array.isArray(previous) && !Array.isArray(next))
    return { ...(previous as object), ...(next as object) };
  return next ?? previous;
}
function applyTool(value: TranscriptFoldValue, tool: TranscriptFoldTool): void {
  const index = tool.callId ? value.transcript.findIndex((entry) => entry.tool?.callId === tool.callId) : -1;
  if (index < 0) { append(value, { role: "assistant", text: "", tool }); return; }
  const entry = value.transcript[index]!; const previous = entry.tool!;
  value.transcript[index] = { ...entry, tool: { ...previous, status: tool.status, result: tool.result ?? previous.result,
    detail: tool.detail ?? previous.detail, input: tool.status === "running" ? mergeInput(previous.input, tool.input) : previous.input } };
}
function closeTools(value: TranscriptFoldValue): void {
  value.transcript = value.transcript.map((entry) => entry.tool?.status === "running"
    ? { ...entry, tool: { ...entry.tool, status: "done" } } : entry);
}
function toolId(event: ServerEvent, entries: readonly TranscriptFoldEntry[]): string {
  const explicit = toolCallId(event as any); if (explicit) return explicit;
  const name = toolName(event as any); const input = toolInput(event as any) as Record<string, unknown>;
  const target = String(input?.command || input?.cmd || input?.path || input?.file || input?.filePath || input?.query || input?.stream || "");
  return target || name === "agent_output" || name === "stderr" || name === "stdout" ? `${name}:${target}` : idFor(entries);
}
function toolLabel(event: ServerEvent, entries: readonly TranscriptFoldEntry[]): string {
  const name = toolName(event as any);
  if (name === "agent_output" || name === "stderr" || name === "stdout") return "Reading agent output…";
  const callId = toolCallId(event as any);
  const detail: any = toolDetail(event as any) ?? (callId ? entries.find((entry) => entry.tool?.callId === callId)?.tool?.detail : undefined);
  return detail?.kind === "delegation" ? (detail.label ? `${detail.label} sub-agent is working…` : "Sub-agent is working…") : `Running ${name}…`;
}
function attachmentHashes(entries: readonly TranscriptFoldEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => entry.attachments ?? []).map((item) => item.hash).filter((hash): hash is string => Boolean(hash)));
}
function flushAttachments(value: TranscriptFoldValue): boolean {
  if (!value.pendingAgentAttachments.length) return false;
  const present = attachmentHashes(value.transcript);
  const fresh = value.pendingAgentAttachments.filter((item) => !item.attachment.hash || !present.has(item.attachment.hash));
  value.pendingAgentAttachments = [];
  if (!fresh.length) return true;
  let turnStart = -1;
  for (let i = value.transcript.length - 1; i >= 0; i--) if (value.transcript[i]!.role === "user") { turnStart = i; break; }
  let target = -1;
  for (let i = value.transcript.length - 1; i > turnStart; i--) {
    const entry = value.transcript[i]!;
    if (entry.role === "assistant" && !entry.tool && entry.text && !entry.attachments?.length) { target = i; break; }
  }
  if (target >= 0) {
    const entry = value.transcript[target]!;
    value.transcript[target] = { ...entry, attachments: [...(entry.attachments ?? []), ...fresh.map((item) => item.attachment)] };
  } else for (const item of fresh) append(value, { role: "assistant", text: item.caption, attachments: [item.attachment] });
  return true;
}

export function foldTranscriptEvent(input: TranscriptFoldValue, event: ServerEvent, now: number): TranscriptFoldResult {
  const kind = eventKind(event as any);
  if (!kind) return { handled: false, value: input, commands: [] };
  const value = cloneValue(input); const commands: TranscriptFoldCommand[] = [];
  switch (kind) {
    case "agent_start": case "turn_start": value.draft.finalized = false; setWorking(value, kind === "agent_start" ? "Planning…" : "Thinking…"); break;
    case "message_start": if ((event as any).message?.role === "assistant") { value.draft = freshTranscriptDraft(false); setWorking(value, "Drafting response…"); } break;
    case "attachment": {
      const ref = (event as any).ref;
      if (!ref || typeof ref.hash !== "string" || (ref.kind !== "image" && ref.kind !== "file")) return { handled: true, value: input, commands: [] };
      value.pendingAgentAttachments.push({ attachment: { kind: ref.kind, name: ref.name, size: ref.size, mimeType: ref.mimeType, hash: ref.hash, createdAt: now, ...((event as any).artifact ? { artifact: true } : {}) }, caption: typeof (event as any).caption === "string" ? (event as any).caption : "" }); break;
    }
    case "inlineImage": {
      const url = (event as any).url; const ref = (event as any).ref;
      if (typeof url !== "string" || !url || !ref || typeof ref.hash !== "string") return { handled: true, value: input, commands: [] };
      commands.push({ kind: "cache-inline-image", url, ref });
      value.transcript = value.transcript.map((entry) => entry.role === "assistant" && entry.text?.includes(url) && !(entry.imageRefs as any)?.[url]
        ? { ...entry, imageRefs: { ...(entry.imageRefs ?? {}), [url]: ref } } : entry); break;
    }
    case "message_update": case "message_boundary": case "message_end": {
      const msg = (event as any).message; if (msg?.role !== "assistant") return { handled: true, value: input, commands: [] };
      const text = contentToText(msg.content).trim(); if (text) value.draft.pendingText = text;
      const thinking = resolveThinking(event, contentThinking(msg.content).trim(), value.draft); if (thinking && !text) value.draft.sawThinking = true;
      const finalize = kind === "message_end" || kind === "message_boundary";
      if (finalize) { commitThinking(value); commitProse(value); value.draft.finalized = true; }
      else { const label = text ? "Drafting response…" : "Thinking…"; if (!value.working || value.workingLabel !== label) setWorking(value, label); previewProse(value); }
      for (const tool of toolEntriesFromContent(msg.content)) applyTool(value, tool as TranscriptFoldTool); break;
    }
    case "start": commitThinking(value); commitProse(value); finishDrafts(value); applyTool(value, { callId: toolId(event, value.transcript), name: toolName(event as any), input: toolInput(event as any), status: "running", detail: toolDetail(event as any) }); setWorking(value, toolLabel(event, value.transcript)); break;
    case "update": applyTool(value, { callId: toolId(event, value.transcript), name: toolName(event as any), input: toolInput(event as any), status: "running", detail: toolDetail(event as any) }); setWorking(value, toolLabel(event, value.transcript)); break;
    case "result": applyTool(value, { callId: toolId(event, value.transcript), name: toolName(event as any), input: {}, status: "done", result: typeof (event as any).result === "string" ? (event as any).result : contentToText((event as any).result), detail: toolDetail(event as any) }); break;
    case "turn_end": if (flushAttachments(value)) commands.push({ kind: "remember-agent-attachments" }); setWorking(value, "Planning next step…"); break;
    case "agent_end": finishDrafts(value); if (flushAttachments(value)) commands.push({ kind: "remember-agent-attachments" }); closeTools(value); Object.assign(value.draft, { pendingText: "", committedText: "", committedThinking: "" }); value.working = false; value.workingLabel = ""; commands.push({ kind: "turn-settled" }); break;
    default: return { handled: false, value: input, commands: [] };
  }
  return { handled: true, value, commands };
}
