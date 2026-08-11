// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Transcript / event-log persistence glue, extracted from server.ts. This is the
// thin layer between raw runtime events and the append-only EventLog: it maps
// tool/thinking events into log entries, coalesces streaming reasoning into one
// length-capped intermediate entry, resolves remote inline images, and assembles
// the session.history / session.replay events clients consume.
//
// The heavy lifting already lives in ./event-log, ./attachment-store,
// ./inline-image-fetch and ./transcript-merge — this module owns only the
// coalescing state and the event→entry mapping, behind an injected-deps surface,
// so its logic is unit-testable without a live daemon. The EventLog /
// AttachmentStore singletons stay server-owned (GC, delete, replication use them)
// and are injected.

import { randomBytes } from "node:crypto";
import type { EventLog } from "./event-log.js";
import { mergeBases } from "./event-log.js";
import type { AttachmentStore } from "./attachment-store.js";
import { thinkingTextFromContent } from "./transcript-merge.js";
import { extractInlineImageUrls, fetchInlineImage, isFetchImageError, inlineImageDisplayName, assistantTextForImageScan } from "./inline-image-fetch.js";
import { historyDelta, type HistoryCursor } from "../history-sync.js";
import type { RuntimeMessage, RuntimeEvent } from "../runtime/index.js";
import type { PrRef } from "../metadata.js";

type IntermediateMessage = RuntimeMessage & { bivyKind: "intermediate"; afterMessageCount: number; createdAt: number };
type ToolActivityMessage = RuntimeMessage & { bivyKind: "tool"; afterMessageCount: number; createdAt: number };

/** All the persist* functions need is the id and the runtime transcript. */
export interface PersistSession {
  id: string;
  session: { getMessages(): RuntimeMessage[] };
}

/** The extra fields buildHistoryEvent reads off a live record it looks up itself. */
export interface HistoryRecord {
  sessionFile?: string;
  worktree?: { branch?: string };
  warning?: string;
  costUsd?: number;
  usage?: unknown;
  prUrl?: string;
  prs?: PrRef[];
  session: { getName(): string | undefined };
}

export interface TranscriptPersistenceDeps {
  eventLog: EventLog;
  attachmentStore: AttachmentStore;
  broadcast(payload: unknown): void;
  stampSessionEvent(payload: unknown): unknown;
  getOpenSession(id: string): HistoryRecord | undefined;
  bivySessionEnvelope(record: HistoryRecord): unknown;
  sessionState(record: HistoryRecord): unknown;
  runtimeDisplayName(runtimeId: string): string;
  sequencerHead(sessionId: string): number;
  sequencerReplay(sessionId: string, afterSeq: number): { mode: "replay"; head: number; events: unknown[] } | { mode: "reset"; head: number };
  streamEpoch: string;
}

export interface BuildHistoryEventOptions {
  sessionId: string | null;
  workspace: string;
  source?: string;
  runtimeId: string;
  isStreaming: boolean;
  messages: unknown[];
  cursor?: HistoryCursor;
  name?: string;
  branch?: string;
  prUrl?: string;
  prs?: PrRef[];
}

export interface TranscriptPersistence {
  persistTranscriptSnapshot(record: PersistSession): void;
  persistToolActivityFromEvent(record: PersistSession, runtimeEvent: RuntimeEvent): void;
  persistIntermediateFromEvent(record: PersistSession, event: Record<string, unknown>, final?: boolean): void;
  resolveInlineImages(record: PersistSession): void;
  conversationMessages(record: PersistSession): RuntimeMessage[];
  buildHistoryEvent(opts: BuildHistoryEventOptions): Record<string, unknown>;
  buildReplayEvent(sessionId: string, afterSeq: number): Record<string, unknown>;
  /** Drop the coalescing state for a session (tool boundary / agent_end). */
  clearLiveIntermediate(sessionId: string): void;
}

// Display-only intermediate reasoning is persisted as a length-capped HEAD so a
// runaway/looping agent can't grow the append-only log without bound. HEAD (not
// tail): once capped, the persisted text stops changing, so the skip-when-
// unchanged check stops appending entirely — the hard bound on log growth.
const MAX_PERSISTED_THINKING_CHARS = 16_000;
function capThinkingForPersistence(text: string): string {
  if (text.length <= MAX_PERSISTED_THINKING_CHARS) return text;
  return `${text.slice(0, MAX_PERSISTED_THINKING_CHARS)}\n\n[Bivy truncated a very long reasoning stream to bound session-history size.]`;
}

function toolEventId(event: Record<string, unknown>): string {
  const toolCall = event.toolCall as Record<string, unknown> | undefined;
  const input = (event.input || event.toolInput || event.args || toolCall?.input || {}) as Record<string, unknown>;
  const explicit = event.toolUseId || event.tool_use_id || event.toolCallId || event.callId || event.id || toolCall?.id;
  if (explicit) return String(explicit);
  return `${String(event.toolName || event.name || toolCall?.name || "tool")}:${String(input.path || input.file || input.filePath || input.command || input.cmd || input.query || "")}`;
}

function thinkingTextFromEvent(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined;
  const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown; content?: unknown } | undefined;
  const fromMessage = thinkingTextFromContent(message?.content);
  if (fromMessage) return fromMessage;
  if (delta?.type === "thinking_delta" && typeof delta.delta === "string") return delta.delta;
  if (delta?.type === "thinking_end" && typeof delta.content === "string") return delta.content;
  return "";
}

const INLINE_IMAGE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export function createTranscriptPersistence(deps: TranscriptPersistenceDeps): TranscriptPersistence {
  const { eventLog, attachmentStore } = deps;
  const liveIntermediateBySession = new Map<string, IntermediateMessage>();
  const lastPersistedIntermediateText = new Map<string, string>();
  // In-flight dedupe + failure cooldown so a repeated remote image URL only ever
  // triggers one fetch and a broken URL isn't retried every message_end.
  const inlineImageFetchInFlight = new Map<string, Promise<void>>();
  const inlineImageFailedAt = new Map<string, number>();

  function persistTranscriptSnapshot(record: PersistSession): void {
    const base = record.session.getMessages();
    if (!base.length) return;
    const logged = eventLog.readBase(record.id);
    eventLog.appendBaseSnapshot(record.id, logged.length ? mergeBases(logged, base) : base);
  }

  function resolveInlineImages(record: PersistSession): void {
    const messages = record.session.getMessages();
    const urls = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const url of extractInlineImageUrls(assistantTextForImageScan(m.content))) urls.add(url);
    }
    if (!urls.size) return;
    const alreadyResolved = new Set(eventLog.readInlineImages(record.id).map(([url]) => url));
    for (const url of urls) {
      if (alreadyResolved.has(url) || inlineImageFetchInFlight.has(url)) continue;
      const failedAt = inlineImageFailedAt.get(url);
      if (failedAt !== undefined && Date.now() - failedAt < INLINE_IMAGE_RETRY_COOLDOWN_MS) continue;
      const task = (async () => {
        try {
          const result = await fetchInlineImage(url);
          if (isFetchImageError(result)) {
            console.warn(`[inline-image] ${url}: ${result.error}`);
            inlineImageFailedAt.set(url, Date.now());
            return;
          }
          const ref = attachmentStore.put(result.bytes, { name: inlineImageDisplayName(url, result.mimeType), mimeType: result.mimeType, kind: "image" });
          eventLog.appendInlineImage(record.id, { url, ref });
          eventLog.flush(record.id);
          deps.broadcast(deps.stampSessionEvent({ type: "session.event", sessionId: record.id, event: { type: "inlineImage", url, ref } }));
        } catch (error) {
          console.warn(`[inline-image] ${url}:`, error instanceof Error ? error.message : String(error));
          inlineImageFailedAt.set(url, Date.now());
        } finally {
          inlineImageFetchInFlight.delete(url);
        }
      })();
      inlineImageFetchInFlight.set(url, task);
    }
  }

  function persistToolActivityFromEvent(record: PersistSession, runtimeEvent: RuntimeEvent): void {
    const event = runtimeEvent as Record<string, unknown>;
    const type = String(event.type || "");
    if (!["tool_call", "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result", "function_call", "function_result"].includes(type)) return;
    const callId = toolEventId(event);
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    const input = (event.input || event.toolInput || event.args || toolCall?.input || {}) as Record<string, unknown>;
    const name = String(event.toolName || event.name || toolCall?.name || "tool");
    const now = Date.now();
    const base = { role: "assistant" as const, bivyKind: "tool" as const, afterMessageCount: record.session.getMessages().length, createdAt: now };
    if (type === "tool_result" || type === "tool_execution_end" || type === "function_result") {
      eventLog.append(record.id, { ...base, id: `bivy-tool-result-${callId}`, content: [{ type: "tool_result", toolUseId: callId, tool_use_id: callId, content: event.message ?? event.result ?? event.output ?? input.output ?? "", isError: Boolean(event.error || event.errorMessage), ...(event.detail ? { detail: event.detail } : {}) }] } as ToolActivityMessage);
    } else {
      eventLog.append(record.id, { ...base, id: `bivy-tool-call-${callId}`, content: [{ type: "tool_use", id: callId, name, input, ...(event.detail ? { detail: event.detail } : {}) }] } as ToolActivityMessage);
    }
  }

  function persistIntermediateFromEvent(record: PersistSession, event: Record<string, unknown>, final = false): void {
    const text = thinkingTextFromEvent(event).trim();
    if (!text) return;
    const existing = liveIntermediateBySession.get(record.id);
    const entry: IntermediateMessage = existing ?? {
      id: `bivy-intermediate-${Date.now()}-${randomBytes(3).toString("hex")}`,
      role: "assistant",
      content: [{ type: "thinking", thinking: text }],
      bivyKind: "intermediate",
      afterMessageCount: record.session.getMessages().length,
      createdAt: Date.now(),
    };
    const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    const previousText = thinkingTextFromContent(entry.content);
    const nextText = existing && delta?.type === "thinking_delta" && typeof delta.delta === "string" && !thinkingTextFromContent((event.message as { content?: unknown } | undefined)?.content)
      ? `${previousText}${delta.delta}`
      : text;
    entry.content = [{ type: "thinking", thinking: nextText }];
    // Persist a length-capped clone; skip the append when unchanged (a capped-out
    // stream stops growing the log) but always write the final snapshot.
    const capped = capThinkingForPersistence(nextText);
    if (final || lastPersistedIntermediateText.get(record.id) !== capped) {
      eventLog.append(record.id, { ...entry, content: [{ type: "thinking", thinking: capped }] });
    }
    if (final) {
      liveIntermediateBySession.delete(record.id);
      lastPersistedIntermediateText.delete(record.id);
    } else {
      liveIntermediateBySession.set(record.id, entry);
      lastPersistedIntermediateText.set(record.id, capped);
    }
  }

  function clearLiveIntermediate(sessionId: string): void {
    liveIntermediateBySession.delete(sessionId);
    lastPersistedIntermediateText.delete(sessionId);
  }

  function conversationMessages(record: PersistSession): RuntimeMessage[] {
    return eventLog.deriveHistory(record.id, record.session.getMessages());
  }

  function buildHistoryEvent(opts: BuildHistoryEventOptions): Record<string, unknown> {
    const delta = historyDelta(opts.messages, opts.cursor);
    const record = opts.sessionId ? deps.getOpenSession(opts.sessionId) : undefined;
    const bSess = record ? deps.bivySessionEnvelope(record) : undefined;
    return {
      type: "session.history" as const,
      sessionId: opts.sessionId,
      sessionFile: record?.sessionFile,
      workspace: opts.workspace,
      source: opts.source,
      branch: record?.worktree?.branch ?? opts.branch,
      runtimeId: opts.runtimeId,
      agentName: deps.runtimeDisplayName(opts.runtimeId),
      name: record?.session.getName() ?? opts.name,
      isStreaming: opts.isStreaming,
      sessionState: record ? deps.sessionState(record) : undefined,
      mode: delta.mode,
      baseCount: delta.baseCount,
      count: delta.count,
      historyHash: delta.historyHash,
      messages: delta.messages,
      headSeq: opts.sessionId ? deps.sequencerHead(opts.sessionId) : 0,
      streamEpoch: deps.streamEpoch,
      warning: record?.warning,
      costUsd: record?.costUsd,
      usage: record?.usage,
      prUrl: record?.prUrl ?? opts.prUrl,
      prs: record?.prs ?? opts.prs,
      bivySession: bSess,
      attachmentRefs: opts.sessionId ? eventLog.readAttachments(opts.sessionId) : [],
      inlineImageRefs: opts.sessionId ? eventLog.readInlineImages(opts.sessionId) : [],
    };
  }

  function buildReplayEvent(sessionId: string, afterSeq: number): Record<string, unknown> {
    const outcome = deps.sequencerReplay(sessionId, Number.isFinite(afterSeq) ? afterSeq : 0);
    return {
      type: "session.replay" as const,
      sessionId,
      epoch: deps.streamEpoch,
      mode: outcome.mode,
      head: outcome.head,
      events: outcome.mode === "replay" ? outcome.events : [],
    };
  }

  return {
    persistTranscriptSnapshot,
    persistToolActivityFromEvent,
    persistIntermediateFromEvent,
    resolveInlineImages,
    conversationMessages,
    buildHistoryEvent,
    buildReplayEvent,
    clearLiveIntermediate,
  };
}
