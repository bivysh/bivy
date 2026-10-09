// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Markdown/text/transcript-render helpers for the session store. Split out of
// store.ts so the reducer keeps only state-folding logic. These turn raw node
// `content`/`messages` into the TranscriptEntry[] the view renders; they hold no
// state beyond the shared `nextId` sequence (history entries use positional ids).

import { isToolResultBlock, isToolUseBlock, toolCallId, toolDetail, toolInput, toolName, toolParentId } from "./tool-activity.js";
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
import { APP_PIN_BLOCK, APP_PUBLICATION_BLOCK, APP_REVIEW_BLOCK, isAppPin, isAppReference, isAppReview } from "./apps.js";
import { NOTICE_BLOCK, isAgentNotice } from "./notices.js";
import { DELEGATION_BLOCK, isDelegationCard } from "./delegations.js";

interface AgentAttachmentBlock {
  type: typeof AGENT_ATTACHMENT_BLOCK;
  ref: AttachmentRef;
  caption?: string;
  /** See PromptAttachment.artifact — carried on the block by the node's
   *  outbound-attachment log entry (src/session/event-log.ts). */
  artifact?: boolean;
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
 *  identical chip. `extra` carries the fields a ref alone can't: `createdAt`
 *  (only known to the caller — the message's own timestamp on history replay,
 *  "now" on a live event) and `artifact` (the sender's explicit marking, not
 *  part of the content-addressed ref itself since the same bytes can be
 *  attached casually elsewhere too). */
export function attachmentFromRef(ref: AttachmentRef, extra?: { createdAt?: number; artifact?: boolean }): PromptAttachment {
  return {
    kind: ref.kind,
    name: ref.name,
    size: ref.size,
    mimeType: ref.mimeType,
    hash: ref.hash,
    ...(extra?.createdAt !== undefined ? { createdAt: extra.createdAt } : {}),
    ...(extra?.artifact ? { artifact: true } : {}),
  };
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

/** A displayable reasoning block. Pi streams these live and Bivy persists them
 * as intermediate sidecars, so history must render the same blocks too. */
function isThinkingBlock(b: any): boolean {
  const t = String(b?.type || b?.kind || "").toLowerCase();
  return t === "thinking" || t === "reasoning";
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
  if (Array.isArray(content)) {
    return content
      .filter(isTextBlock)
      .map((b) => String(b?.text ?? b?.content ?? ""))
      .join("\n");
  }
  // Tool output is not consistently typed across agents: ACP commonly sends a
  // content block, while some CLIs return `{ output }` or a structured JSON
  // value. Do not silently turn those successful results into an empty card.
  if (content && typeof content === "object") {
    const value = content.text ?? content.content ?? content.output ?? content.result;
    if (typeof value === "string") return value;
    if (value !== undefined) return contentToText(value);
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return content == null ? "" : String(content);
}

export function contentThinking(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isThinkingBlock)
    .map((b) => String(b?.text ?? b?.thinking ?? b?.reasoning ?? ""))
    .join("\n");
}

/** Tool results can contain structured arrays (for example a list of files or
 * diagnostics), not just text blocks. Unlike assistant content, a result has no
 * prose/tool ordering to preserve, so stringify unknown values rather than
 * silently rendering an empty card. */
export function toolResultText(content: any): string {
  if (Array.isArray(content)) {
    const text = content.filter(isTextBlock).map((b) => String(b?.text ?? b?.content ?? "")).join("\n");
    if (text) return unwrapSubagentReport(text);
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return unwrapSubagentReport(contentToText(content));
}

/** Harness frames an agent wraps around a sub-agent's report before handing it
 * to the model. The user should read the report, not the frame. Each row
 * matches the frame's opening (and closing, if any) and how the report inside
 * is indented. Mirrors
 * SUBAGENT_REPORT_FRAMES in the node's src/runtime/tool-call-map.ts. */
const SUBAGENT_REPORT_FRAMES: Array<{ header: RegExp; footer?: RegExp; indent: string }> = [
  // Claude Code 2.1.28x: "[Subagent hand-back] … The report follows:\n  <report>"
  { header: /^\[Subagent hand-back\][^\n]*The report follows:\n/, indent: "  " },
  // OpenCode's task tool: <task id=… state=…>\n<task_result>\n<report>\n</task_result>\n</task>
  { header: /^<task\b[^>\n]*>\s*<task_result>\n?/, footer: /\n?<\/task_result>\s*<\/task>\s*$/, indent: "" },
];

export function unwrapSubagentReport(text: string): string {
  for (const frame of SUBAGENT_REPORT_FRAMES) {
    const match = frame.header.exec(text);
    if (!match) continue;
    const inner = text.slice(match[0].length);
    const body = frame.footer ? inner.replace(frame.footer, "") : inner;
    if (!frame.indent) return body;
    return body
      .split("\n")
      .map((line) => (line.startsWith(frame.indent) ? line.slice(frame.indent.length) : line))
      .join("\n");
  }
  return text;
}

export function toolEntriesFromContent(content: any, parentToolUseId?: string, makeId: () => string = nextId): ToolActivity[] {
  if (!Array.isArray(content)) return [];
  const out: ToolActivity[] = [];
  for (const block of content) {
    if (isToolUseBlock(block)) {
      // A per-block parent wins over the message-level one; both are just a
      // display grouping hint, so a missing id simply leaves the call top-level.
      const parent = toolParentId(block) || parentToolUseId || "";
      out.push({
        callId: toolCallId(block) || makeId(),
        name: toolName(block),
        input: toolInput(block),
        status: "running",
        detail: toolDetail(block),
        ...(parent ? { parentToolUseId: parent } : {}),
      });
    } else if (isToolResultBlock(block)) {
      const id = toolCallId(block);
      const result = toolResultText(block?.content);
      const existingDetail = toolDetail(block);
      // Some runtimes persist the failure only on the tool_result block. Carry
      // that outcome into the normalized detail so a reloaded card is marked
      // failed just like its live counterpart (without an agent-specific path).
      const detail = (block?.isError || block?.is_error) && existingDetail
        ? { ...existingDetail, result: { ...(existingDetail.result ?? {}), isError: true } }
        : (block?.isError || block?.is_error ? { kind: "unknown", result: { isError: true } } as ToolActivity["detail"] : existingDetail);
      out.push({ callId: id, name: toolName(block), input: {}, status: "done", result, ...(detail ? { detail } : {}) });
    }
  }
  return out;
}

function toolEntryFromToolResultMessage(msg: any): ToolActivity | null {
  const callId = String(msg?.toolCallId || msg?.toolUseId || msg?.tool_use_id || msg?.id || "");
  // Some providers omit ids from result envelopes. Keep the anonymous result
  // so mergeToolInto can correlate it with the newest open call.
  return {
    callId,
    name: String(msg?.toolName || msg?.name || "tool").toLowerCase(),
    input: {},
    status: "done",
    result: toolResultText(msg?.content),
    detail: (msg?.isError || msg?.is_error)
      ? (toolDetail(msg) ?? ({ kind: "unknown", result: { isError: true } } as ToolActivity["detail"]))
      : toolDetail(msg),
  };
}

/** References may be nested inside SDK tool-result envelopes. */
export function embeddedAttachments(value: unknown): PromptAttachment[] {
  const refs = new Map<string, PromptAttachment>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (isAgentAttachmentBlock(value)) { refs.set(value.ref.hash, attachmentFromRef(value.ref)); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    // Content envelopes only; don't interpret tool arguments as attachments.
    if (record.content) visit(record.content);
  }
  visit(value);
  return [...refs.values()];
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
  const toolImages = new Set<string>();
  // Ids come from where an entry sits in the history, not a counter: history
  // only grows at the end, so a re-render (after a turn, a reconnect, a
  // resync) keeps every row's React key and nothing on screen remounts.
  let index = -1, slot = 0;
  const historyId = () => `h${index}.${slot++}`;
  for (const msg of messages || []) {
    index++; slot = 0;
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
            for (const tool of toolEntriesFromContent([block], undefined, historyId)) mergeToolInto(entries, tool, historyId);
          }
        }
      }
      const attachments = embeddedAttachments(content);
      if ((text && !isMetaText(text)) || attachments.length) entries.push({ id: historyId(), role: "user", text, ...(attachments.length ? { attachments } : {}) });
    } else if (role === "system") {
      if (text && !isMetaText(text)) entries.push({ id: historyId(), role: "system", text });
    } else if (role === "toolresult" || role === "tool_result") {
      const tool = toolEntryFromToolResultMessage(msg);
      if (tool) mergeToolInto(entries, tool, historyId);
    } else {
      // Claude's Agent SDK stamps every persisted message it generated inside a
      // `Task` sub-agent with a message-level parent_tool_use_id; carry it onto
      // this turn's tool cards so a reloaded transcript nests them under the
      // delegation exactly like the live stream does.
      const msgParent = toolParentId(msg);
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
            ? { id: historyId(), role: "error", text: humanizeError(trimmed) }
            : { id: historyId(), role: "assistant", text: trimmed },
        );
      };
      const pushThinking = (t: string) => {
        const trimmed = t.trim();
        if (trimmed) entries.push({ id: historyId(), role: "thinking", text: trimmed });
      };
      if (typeof content === "string" || !Array.isArray(content)) {
        pushText(text);
      } else {
        let textBuf: string[] = [];
        let thinkingBuf: string[] = [];
        const flushText = () => { pushText(textBuf.join("\n")); textBuf = []; };
        const flushThinking = () => { pushThinking(thinkingBuf.join("\n")); thinkingBuf = []; };
        const flushRuns = () => { flushText(); flushThinking(); };
        for (const block of content) {
          if (isToolUseBlock(block) || isToolResultBlock(block)) {
            flushRuns();
            for (const tool of toolEntriesFromContent([block], msgParent, historyId)) mergeToolInto(entries, tool, historyId);
          } else if (block?.type === APP_PUBLICATION_BLOCK && isAppReference(block.app)) {
            flushRuns();
            // The live app_published event's id, so the card survives the reload.
            entries.push({ id: `app-${block.app.appId}`, role: "assistant", text: "", app: block.app });
          } else if (block?.type === NOTICE_BLOCK && isAgentNotice(block.notice)) {
            flushRuns();
            entries.push({ id: block.notice.id, role: "assistant", text: "", notice: block.notice });
          } else if (block?.type === DELEGATION_BLOCK && isDelegationCard(block.delegation)) {
            flushRuns();
            entries.push({ id: `delegation-${block.delegation.id}`, role: "assistant", text: "", delegation: block.delegation });
          } else if (block?.type === APP_REVIEW_BLOCK && isAppReview(block.review)) {
            flushRuns();
            entries.push({ id: block.review.id, role: "assistant", text: "", review: block.review });
          } else if (block?.type === APP_PIN_BLOCK && isAppPin(block.pin)) {
            flushRuns();
            entries.push({ id: block.pin.id, role: "assistant", text: "", pin: block.pin });
          } else if (isAgentAttachmentBlock(block)) {
            // Seal any prose/reasoning before the attachment so its source order
            // is retained and the chip lands as its own entry.
            flushRuns();
            const createdAt = typeof msg?.createdAt === "number" ? msg.createdAt : undefined;
            entries.push({
              id: historyId(),
              role: "assistant",
              text: typeof block.caption === "string" ? block.caption : "",
              attachments: [{ ...attachmentFromRef(block.ref, { createdAt, artifact: block.artifact }), description: typeof block.caption === "string" ? block.caption : undefined }],
            });
          } else if (isTextBlock(block)) {
            flushThinking();
            textBuf.push(String(block?.text ?? block?.content ?? ""));
          } else if (isThinkingBlock(block)) {
            flushText();
            thinkingBuf.push(String(block?.thinking ?? block?.reasoning ?? block?.text ?? ""));
          } else if (String(block?.type || "").toLowerCase() === "bivy_message_boundary") {
            // Protocol runtimes persist this display-only delimiter between
            // discrete assistant items (notably Codex commentary). Seal the
            // current run so a reload keeps separate messages separate, even
            // when no tool call happened between them.
            flushRuns();
          }
        }
        flushRuns();
      }
      // A turn the model/provider failed is persisted as an assistant message
      // with stopReason "error" and (usually empty content +) an errorMessage.
      // Without this it reloaded as a blank turn — the "looks done, no reply"
      // gap. Render it as an inline error so history matches the live view.
      if (msg?.stopReason === "error" && typeof msg?.errorMessage === "string" && msg.errorMessage.trim()) {
        entries.push({ id: historyId(), role: "error", text: humanizeError(msg.errorMessage) });
      }
    }
    // Raw tool results and their Bivy overlays can contain the same image.
    // Show one lazy attachment per call/hash, adjacent to the tool's result.
    if (role !== "user" && role !== "system") {
      const candidates = role === "toolresult" || role === "tool_result"
        ? [{ id: msg.toolCallId || msg.toolUseId || msg.tool_use_id || msg.id, content }]
        : (Array.isArray(content) ? content.filter(isToolResultBlock).map(block => ({ id: toolCallId(block), content: block.content })) : []);
      for (const candidate of candidates) {
        const attachments = embeddedAttachments(candidate.content).filter(ref => {
          const key = `${candidate.id || ""}:${ref.hash}`;
          if (toolImages.has(key)) return false;
          toolImages.add(key);
          return true;
        });
        if (attachments.length) entries.push({ id: historyId(), role: "assistant", text: "", attachments, toolOutput: true });
      }
    }
  }
  // Cards keep their own ids (an app, a review), which history may repeat.
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const n = seen.get(entry.id) ?? 0;
    seen.set(entry.id, n + 1);
    if (n) entry.id = `${entry.id}~${n}`;
  }
  return entries;
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

/** Shallow-merge a streaming tool call's inputs so a later partial update
 *  (a progress ping, a late `rawInput`) augments rather than replaces what the
 *  card already knows. Non-object inputs fall back to the newer truthy value. */
function mergeToolInput(prev: unknown, next: unknown): unknown {
  const prevObj = prev && typeof prev === "object" && !Array.isArray(prev);
  const nextObj = next && typeof next === "object" && !Array.isArray(next);
  if (prevObj && nextObj) return { ...(prev as Record<string, unknown>), ...(next as Record<string, unknown>) };
  return next ?? prev;
}

export function mergeToolInto(entries: TranscriptEntry[], tool: ToolActivity, makeId: () => string = nextId): void {
  // A few CLIs omit the call id on result events. Pair an anonymous result with
  // the newest still-running call of the same tool (or, when the tool name is
  // the generic fallback, the newest running call). This keeps the universal
  // transcript useful without teaching the daemon about another agent format.
  const existing = tool.callId
    ? entries.find((e) => e.tool && e.tool.callId === tool.callId)
    : [...entries].reverse().find((e) => e.tool && e.tool.status === "running" && (tool.name === "tool" || e.tool.name === tool.name));
  if (existing && existing.tool) {
    existing.tool = {
      ...existing.tool,
      status: tool.status,
      result: tool.result ?? existing.tool.result,
      detail: tool.detail ?? existing.tool.detail,
      // A result-only echo has no parent hint; keep the one the call landed with.
      parentToolUseId: tool.parentToolUseId ?? existing.tool.parentToolUseId,
      // Merge, don't replace, while a call streams. A progress-only ping (e.g.
      // Claude's `tool_execution_update` carrying just `{ elapsedSeconds }`)
      // would otherwise clobber the original call's `command`/`path`, blanking
      // the row label for any tool the node couldn't classify into `detail`.
      // A later enriching update (e.g. opencode's late `rawInput`) still wins
      // per-key. On completion (`done`) the input is frozen as-is.
      // Results commonly carry the placeholder name "tool" and no input;
      // preserve the call's identity and display metadata in that case.
      name: tool.status === "done" && tool.name === "tool" ? existing.tool.name : tool.name,
      input: tool.status === "running" ? mergeToolInput(existing.tool.input, tool.input) : existing.tool.input,
    };
  } else {
    entries.push({ id: makeId(), role: "assistant", text: "", tool });
  }
}
