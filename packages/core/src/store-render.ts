// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Markdown/text/transcript-render helpers for the session store. Split out of
// store.ts so the reducer keeps only state-folding logic. These turn raw node
// `content`/`messages` into the TranscriptEntry[] the view renders; they hold no
// state beyond the shared `nextId` sequence.

import { isToolResultBlock, isToolUseBlock, toolCallId, toolDetail, toolInput, toolName } from "./tool-activity.js";
import { humanizeError, looksLikeAgentError } from "./store-errors.js";
import type { AttachmentRef, PromptAttachment } from "./protocol.js";
import type { ToolActivity, TranscriptEntry } from "./store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The content-block type an agent-sent attachment is carried as inside a
 *  synthetic assistant message. The node emits it live as an `attachment`
 *  session event and, for durable history, folds it into the transcript as a
 *  time-anchored overlay message carrying exactly this block (see the node's
 *  event-log outbound-attachment projection). Renders here to a normal
 *  attachment chip/thumbnail, reusing the same PromptAttachment path user
 *  uploads use. */
export const AGENT_ATTACHMENT_BLOCK = "bivy_attachment";

interface AgentAttachmentBlock {
  type: typeof AGENT_ATTACHMENT_BLOCK;
  ref: AttachmentRef;
  caption?: string;
}

function isAgentAttachmentBlock(block: any): block is AgentAttachmentBlock {
  return (
    !!block &&
    block.type === AGENT_ATTACHMENT_BLOCK &&
    !!block.ref &&
    typeof block.ref.hash === "string" &&
    (block.ref.kind === "image" || block.ref.kind === "file")
  );
}

/** A durable AttachmentRef → the (byte-less) PromptAttachment the view renders
 *  by hash. Shared by history render and the live reducer so both produce an
 *  identical chip. */
export function attachmentFromRef(ref: AttachmentRef): PromptAttachment {
  return { kind: ref.kind, name: ref.name, size: ref.size, mimeType: ref.mimeType, hash: ref.hash };
}

let idSeq = 0;
/** Monotonic transcript-entry id. Shared by the render helpers and the reducer so
 *  every entry (rendered-from-history or live) draws from one sequence. */
export const nextId = (): string => `e${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/**
 * Flatten a message `content` (string | block[]) to display text.
 *
 * Joins multiple "text" blocks with "\n", not "". Some runtimes (unlike the
 * Anthropic SDK's single accumulating text delta) emit an assistant message's
 * content as several discrete text blocks that grow over the course of a
 * turn. Gluing those blocks together with no separator can weld prose
 * directly onto a fenced code block's opening/closing ``` marker (e.g.
 * "...cache:```js" instead of "...cache:\n```js"), which knocks the fence off
 * its own line and makes the block-level markdown parser miss it entirely —
 * the whole message then falls through to the paragraph/inline-code path and
 * renders as one unstyled blob. "\n" matches the convention already used by
 * the legacy client's equivalent `textContent()` helper.
 */
/** A displayable prose block (`text` / `output_text`, or an untyped `{text}`). */
function isTextBlock(b: any): boolean {
  const t = String(b?.type || b?.kind || "").toLowerCase();
  return t === "text" || t === "output_text" || (!t && typeof b?.text === "string");
}

/** Harness "meta" markers the Claude Code CLI writes into its transcript for the
 *  model — task-notification / system-reminder wrappers and the synthetic
 *  "[Request interrupted by user]" marker. The runtime layer already filters
 *  these before persistence (src/runtime/claude-code.ts); this is a render-time
 *  net for history that was persisted *before* that filter existed, or produced
 *  by another path. Kept narrow (known tags + the interrupt marker) so a real
 *  user message starting with "<div>" is never suppressed. */
const META_TEXT = /^\s*(?:\[Request interrupted by user|<(?:task-notification|system-reminder)[\s>/])/;
function isMetaText(text: string): boolean {
  return META_TEXT.test(text);
}

export function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextBlock)
    .map((b) => String(b?.text ?? b?.content ?? ""))
    .join("\n");
}

export function contentThinking(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => String(b?.type || b?.kind || "").toLowerCase() === "thinking")
    .map((b) => String(b?.text ?? b?.thinking ?? ""))
    .join("\n");
}

export function toolEntriesFromContent(content: any): ToolActivity[] {
  if (!Array.isArray(content)) return [];
  const out: ToolActivity[] = [];
  for (const block of content) {
    if (isToolUseBlock(block)) {
      out.push({
        callId: toolCallId(block) || nextId(),
        name: toolName(block),
        input: toolInput(block),
        status: "running",
        detail: toolDetail(block),
      });
    } else if (isToolResultBlock(block)) {
      const id = toolCallId(block);
      const result = typeof block?.content === "string" ? block.content : contentToText(block?.content);
      out.push({ callId: id, name: toolName(block), input: {}, status: "done", result, detail: toolDetail(block) });
    }
  }
  return out;
}

function toolEntryFromToolResultMessage(msg: any): ToolActivity | null {
  const callId = String(msg?.toolCallId || msg?.toolUseId || msg?.tool_use_id || msg?.id || "");
  if (!callId) return null;
  return {
    callId,
    name: String(msg?.toolName || msg?.name || "tool").toLowerCase(),
    input: {},
    status: "done",
    result: contentToText(msg?.content),
    detail: toolDetail(msg),
  };
}

/** Build a fresh transcript from a node `messages[]` array (session.history).
 *
 *  Entries carry only raw `text`; the markdown `html` is left unset for the
 *  view to render lazily (ChatView's EntryView) for the entries it actually
 *  mounts. Rendering markdown for every message here was synchronous, ran over
 *  the whole transcript on every open/backfill, and was the blocking cost that
 *  made opening a long session slow — deferring it to the visible window keeps
 *  the work proportional to what's on screen. (Live streaming still sets `html`
 *  as it drafts, so an in-flight turn paints without a per-entry render.) */
export function renderHistory(messages: any[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const msg of messages || []) {
    const role = String(msg?.role || "assistant").toLowerCase();
    const content = msg?.content;
    const text = contentToText(content);
    if (role === "user") {
      // Runtimes (Claude Code, pi) persist tool RESULTS as tool_result blocks
      // inside a role:"user" message — the SDK echoes them back that way — not as
      // a top-level role:"toolresult" message. Merge those into their originating
      // tool_use card so it flips "running" → "done". Without this, a history
      // rebuilt purely from the transcript (a fork has no live agent_end and no
      // tool sidecar to close cards) shows every past tool call spinning forever.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isToolResultBlock(block)) {
            for (const tool of toolEntriesFromContent([block])) mergeToolInto(entries, tool);
          }
        }
      }
      if (text && !isMetaText(text)) entries.push({ id: nextId(), role: "user", text });
    } else if (role === "system") {
      if (text && !isMetaText(text)) entries.push({ id: nextId(), role: "system", text });
    } else if (role === "toolresult" || role === "tool_result") {
      const tool = toolEntryFromToolResultMessage(msg);
      if (tool) mergeToolInto(entries, tool);
    } else {
      // Walk the content blocks in order so text runs and tool cards interleave
      // exactly as the model produced them. One assistant message is frequently
      // text → tool_use → text (e.g. Codex: "I'll do X." → runs commands →
      // "Done."). Flattening all text first and appending all tools both merged
      // the two prose segments into a single bubble AND hoisted the tool cards
      // above the text that preceded them.
      const pushText = (t: string) => {
        const trimmed = t.trim();
        if (!trimmed) return;
        entries.push(
          looksLikeAgentError(trimmed)
            ? { id: nextId(), role: "error", text: humanizeError(trimmed) }
            : { id: nextId(), role: "assistant", text: trimmed },
        );
      };
      if (typeof content === "string" || !Array.isArray(content)) {
        pushText(text);
      } else {
        let buf: string[] = [];
        for (const block of content) {
          if (isToolUseBlock(block) || isToolResultBlock(block)) {
            pushText(buf.join("\n"));
            buf = [];
            for (const tool of toolEntriesFromContent([block])) mergeToolInto(entries, tool);
          } else if (isAgentAttachmentBlock(block)) {
            // Seal any prose before the attachment so a caption the agent wrote
            // above it stays above it, and the chip lands as its own entry.
            pushText(buf.join("\n"));
            buf = [];
            entries.push({
              id: nextId(),
              role: "assistant",
              text: typeof block.caption === "string" ? block.caption : "",
              attachments: [attachmentFromRef(block.ref)],
            });
          } else if (isTextBlock(block)) {
            buf.push(String(block?.text ?? block?.content ?? ""));
          }
          // thinking / other block types are skipped here, as before.
        }
        pushText(buf.join("\n"));
      }
      // A turn the model/provider failed is persisted as an assistant message
      // with stopReason "error" and (usually empty content +) an errorMessage.
      // Without this it reloaded as a blank turn — the "looks done, no reply"
      // gap. Render it as an inline error so history matches the live view.
      if (msg?.stopReason === "error" && typeof msg?.errorMessage === "string" && msg.errorMessage.trim()) {
        entries.push({ id: nextId(), role: "error", text: humanizeError(msg.errorMessage) });
      }
    }
  }
  return groupAgentAttachments(entries);
}

/**
 * Group agent-sent attachment entries onto the FINAL assistant prose bubble of
 * their turn, so a chip reads as part of the reply instead of standing alone
 * wherever `bivy attach` happened to run in the turn. An "attachment entry" is an
 * assistant entry carrying `attachments` (only agent attachments put attachments
 * on an assistant entry); the "final bubble" is the last assistant text entry in
 * the same turn (turns are delimited by user messages). When a turn has no prose
 * bubble to hang them on (the agent only attached), the attachment entries are
 * left as-is. This is the durable-history twin of the live reducer's
 * flushPendingAgentAttachments, so a reload matches what streamed.
 */
export function groupAgentAttachments(entries: TranscriptEntry[]): TranscriptEntry[] {
  const isAttachmentEntry = (e: TranscriptEntry) => e.role === "assistant" && !e.tool && !!e.attachments && e.attachments.length > 0;
  const isProseBubble = (e: TranscriptEntry) => e.role === "assistant" && !e.tool && !!e.text && !(e.attachments && e.attachments.length);
  const out = entries.slice();
  const remove = new Set<number>();
  let i = 0;
  while (i < out.length) {
    if (out[i]!.role === "user") { i++; continue; }
    // A turn is the maximal run of non-user entries starting at i.
    let j = i;
    while (j < out.length && out[j]!.role !== "user") j++;
    let target = -1;
    const attachmentIdxs: number[] = [];
    for (let k = i; k < j; k++) {
      if (isAttachmentEntry(out[k]!)) attachmentIdxs.push(k);
      else if (isProseBubble(out[k]!)) target = k; // last prose bubble wins
    }
    if (attachmentIdxs.length && target >= 0) {
      const chips = attachmentIdxs.flatMap((k) => out[k]!.attachments!);
      out[target] = { ...out[target]!, attachments: [...(out[target]!.attachments ?? []), ...chips] };
      for (const k of attachmentIdxs) remove.add(k);
    }
    i = j;
  }
  return remove.size ? out.filter((_, idx) => !remove.has(idx)) : out;
}

/**
 * Strip the machine-facing attachment placeholder blocks the node appends to a
 * user prompt's persisted text (see attachmentsFrom in src/server.ts) so the
 * chat shows only the caption the user actually typed. The real attachments are
 * rendered separately as thumbnails/chips from the attachment cache, so the
 * bracketed "[Image attachment: foo.png (123 bytes)]" / "[File attachment: …]"
 * lines — and the "--- File attachment: … ---" text section — are redundant
 * noise once a thumbnail is present.
 *
 * This exists to fix an inconsistency: the optimistic bubble shown the instant
 * you hit send carries only your raw caption (no placeholder), but the node
 * persists caption + placeholder, so a later history-based re-render suddenly
 * grew a literal "[Image attachment: …]" line under the message. Only apply this
 * for display when the entry actually carries re-attached content — a message
 * whose attachments couldn't be recovered keeps the placeholder as its sole
 * remaining signal that something was attached.
 */
export function stripAttachmentPlaceholders(text: string): string {
  if (!text) return text;
  return text
    // Fenced text-file section: --- File attachment: … --- <content> --- end … ---
    .replace(/\n*---\s*File attachment:[\s\S]*?---\s*end[^\n]*---/g, "")
    // Bracketed image / binary-file placeholder lines.
    .replace(/\[(?:Image|File) attachment:[^\]\n]*\]/g, "")
    // Tidy up the blank gaps left where blocks were removed.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mergeToolInto(entries: TranscriptEntry[], tool: ToolActivity): void {
  const existing = tool.callId ? entries.find((e) => e.tool && e.tool.callId === tool.callId) : undefined;
  if (existing && existing.tool) {
    existing.tool = {
      ...existing.tool,
      status: tool.status,
      result: tool.result ?? existing.tool.result,
      detail: tool.detail ?? existing.tool.detail,
      input: tool.status === "running" ? tool.input : existing.tool.input,
    };
  } else {
    entries.push({ id: nextId(), role: "assistant", text: "", tool });
  }
}
