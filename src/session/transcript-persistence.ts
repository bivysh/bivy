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

import { createClientProjection } from "./client-projection.js";
import { randomBytes } from "node:crypto";
import type { EventLog } from "./event-log.js";
import { mergeBases } from "./event-log.js";
import type { AttachmentStore } from "./attachment-store.js";
import { thinkingTextFromContent } from "./transcript-merge.js";
import { extractInlineImageUrls, extractWorkspaceRefs, fetchInlineImage, isFetchImageError, inlineImageDisplayName, assistantTextForImageScan } from "./inline-image-fetch.js";
import { planAttachment, isAttachPlanError } from "./attach-to-chat.js";
import type { ReferenceSyntax } from "./message-components.js";
import { historyDelta, type HistoryCursor } from "../history-sync.js";
import { withToolDetails } from "../runtime/tool-call-map.js";
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
  /** `workspaceDir` is the confinement root — the caller's resolved working
   *  directory for this session (worktree path, cwd, or workspace). */
  resolveWorkspaceRefs(record: PersistSession, workspaceDir: string): void;
  conversationMessages(record: PersistSession): RuntimeMessage[];
  forkMessages(record: PersistSession): RuntimeMessage[];
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
  // Structured-pipe parsers (Grok/Goose/Gemini/… via the shared TurnAccumulator)
  // emit a `tool_result` whose id lives under `result.toolCallId`, not at the top
  // level. Without reading it here the result overlay was keyed `"<name>:"` and
  // never paired with its `tool_call` overlay — orphaning the output in the
  // transcript. Check the nested result id as a general shape, not a per-agent
  // branch (protocol agents that already set a top-level id are unaffected).
  const result = (event.result || event.toolResult) as Record<string, unknown> | undefined;
  const explicit =
    event.toolUseId || event.tool_use_id || event.toolCallId || event.callId || event.id || toolCall?.id ||
    result?.toolCallId || result?.tool_use_id || result?.toolUseId || result?.id;
  if (explicit) return String(explicit);
  return `${String(event.toolName || event.name || toolCall?.name || "tool")}:${String(input.path || input.file || input.filePath || input.command || input.cmd || input.query || "")}`;
}

// Input keys that carry only "still working" liveness, no tool identity.
const PROGRESS_ONLY_INPUT_KEYS = new Set(["elapsedSeconds", "elapsed_time_seconds", "elapsedTimeSeconds", "status"]);

/** A `tool_execution_start`/`_update` (or `tool_progress`) keep-alive that adds
 *  no classification (`detail`) and whose input is purely liveness markers —
 *  the shape that must never overwrite the initiating `tool_call`'s overlay. */
function isProgressOnlyPing(type: string, detail: unknown, input: Record<string, unknown>): boolean {
  if (detail) return false;
  if (type !== "tool_execution_start" && type !== "tool_execution_update" && type !== "tool_progress") return false;
  const keys = Object.keys(input);
  return keys.length > 0 && keys.every((k) => PROGRESS_ONLY_INPUT_KEYS.has(k));
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

/** Ceiling for one workspace file copied into the transcript. Matches the
 *  remote cap (MAX_INLINE_IMAGE_BYTES) rather than the larger explicit-attach
 *  one: a `![…](path)` is incidental illustration the agent spent no tool call
 *  on, and every byte is persisted in the event log and replicated to phones. An
 *  agent that means to send something big still has `bivy attach`. */
const MAX_WORKSPACE_REF_BYTES = 8 * 1024 * 1024;

export function createTranscriptPersistence(deps: TranscriptPersistenceDeps): TranscriptPersistence {
  const { eventLog, attachmentStore } = deps;
  const project = createClientProjection(attachmentStore, eventLog);
  const liveIntermediateBySession = new Map<string, IntermediateMessage>();
  // `${sessionId}\0${callId}` -> what the call's first event recorded. Runtimes
  // stream progress as updates that carry only partial output (Pi's bash), so
  // an update without its own detail/parent keeps the call's, rather than
  // overwriting the persisted card with a generic one.
  const toolCallOverlay = new Map<string, { detail?: unknown; parentToolUseId?: string }>();
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

  /** Every distinct reference the session's assistant messages make, via the
   *  extractor for one origin. */
  function imageRefsInTranscript(record: PersistSession, extract: (text: string) => string[]): Set<string> {
    const refs = new Set<string>();
    for (const m of record.session.getMessages()) {
      if (m.role !== "assistant") continue;
      for (const ref of extract(assistantTextForImageScan(m.content))) refs.add(ref);
    }
    return refs;
  }

  /** The same, for workspace references, keeping which syntax asked for each.
   *  First mention wins: a path written as an image and as a directive is one
   *  file read, and the stricter image rule applies to it. */
  function workspaceRefsInTranscript(record: PersistSession): Map<string, ReferenceSyntax> {
    const refs = new Map<string, ReferenceSyntax>();
    for (const m of record.session.getMessages()) {
      if (m.role !== "assistant") continue;
      for (const { ref, syntax } of extractWorkspaceRefs(assistantTextForImageScan(m.content))) {
        if (!refs.has(ref)) refs.set(ref, syntax);
      }
    }
    return refs;
  }

  /** Store resolved bytes under `ref` and tell every client, durably and live.
   *  One place, so the remote and workspace resolvers below cannot drift in how
   *  they record what they found. `kind` carries whether the bytes are an image,
   *  which is what lets the view layer pick a renderer for a `::view` that
   *  points at something other than a picture. */
  function recordResolvedRef(sessionId: string, ref: string, bytes: Buffer, meta: { name: string; mimeType: string; kind?: "image" | "file" }): void {
    const stored = attachmentStore.put(bytes, { name: meta.name, mimeType: meta.mimeType, kind: meta.kind ?? "image" });
    eventLog.appendInlineImage(sessionId, { url: ref, ref: stored });
    eventLog.flush(sessionId);
    deps.broadcast(deps.stampSessionEvent({ type: "session.event", sessionId, event: { type: "inlineImage", url: ref, ref: stored } }));
  }

  /**
   * Resolve markdown images an agent wrote as a path inside the session
   * workspace (`![Coverage](out/coverage.png)`) — the common case, since the
   * file the agent just produced is right there and writing the markdown costs
   * it nothing. Bytes are copied into the content-addressed AttachmentStore now,
   * at emit time, because the transcript outlives the workspace: an ephemeral
   * machine is destroyed, and history still has to render on a phone weeks later.
   *
   * Confinement is planAttachment's, exactly as for `bivy attach` — the resolved
   * real path must sit inside the session's working directory. That matters more
   * here than there: this path comes from message *prose*, so a prompt injection
   * can propose one. The grammar refuses absolute paths and traversal before we
   * get here; planAttachment is what actually proves containment, symlinks
   * included.
   *
   * Synchronous (a local read, unlike a remote fetch) and resolved once per
   * reference per session, so re-rendering history never re-reads the disk. One
   * consequence: if the agent overwrites a file it already referenced and
   * references the same path again, the chat keeps showing the first version.
   * Distinct paths are the workaround until componentRefs carry a per-message
   * anchor the way outbound attachments already do.
   */
  function resolveWorkspaceRefs(record: PersistSession, workspaceDir: string): void {
    if (!workspaceDir) return;
    const refs = workspaceRefsInTranscript(record);
    if (!refs.size) return;
    const alreadyResolved = new Set(eventLog.readInlineImages(record.id).map(([ref]) => ref));
    for (const [rel, syntax] of refs) {
      if (alreadyResolved.has(rel)) continue;
      const failedAt = inlineImageFailedAt.get(rel);
      if (failedAt !== undefined && Date.now() - failedAt < INLINE_IMAGE_RETRY_COOLDOWN_MS) continue;
      const plan = planAttachment({ workspaceDir, filePath: rel, maxBytes: MAX_WORKSPACE_REF_BYTES });
      if (isAttachPlanError(plan)) {
        console.warn(`[component] ${rel}: ${plan.error}`);
        inlineImageFailedAt.set(rel, Date.now());
        continue;
      }
      // `![…](notes.md)` is a link the agent mistyped, not an image, so refusing
      // non-image bytes keeps a stray one from becoming an unopenable chip. A
      // `::view{src=notes.md}` asked for the file on purpose, so it is kept and
      // the view layer picks a renderer from the mime type.
      if (syntax === "image" && plan.kind !== "image") {
        console.warn(`[component] ${rel}: not an image (${plan.mimeType})`);
        inlineImageFailedAt.set(rel, Date.now());
        continue;
      }
      try {
        recordResolvedRef(record.id, rel, plan.bytes, { name: plan.name, mimeType: plan.mimeType, kind: plan.kind });
      } catch (error) {
        console.warn(`[component] ${rel}:`, error instanceof Error ? error.message : String(error));
        inlineImageFailedAt.set(rel, Date.now());
      }
    }
  }

  function resolveInlineImages(record: PersistSession): void {
    const urls = imageRefsInTranscript(record, extractInlineImageUrls);
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
          recordResolvedRef(record.id, url, result.bytes, { name: inlineImageDisplayName(url, result.mimeType), mimeType: result.mimeType });
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
    // A turn-level failure some runtimes report on the tool channel (Claude's
    // non-success `result`) names no tool and no call: it is not tool activity,
    // and persisting it left a blank error card keyed "tool:".
    if (callId === "tool:" && !event.toolName && !event.name) return;
    const toolCall = event.toolCall as Record<string, unknown> | undefined;
    const input = (event.input || event.toolInput || event.args || toolCall?.input || {}) as Record<string, unknown>;
    const name = String(event.toolName || event.name || toolCall?.name || "tool");
    const now = Date.now();
    const base = { role: "assistant" as const, bivyKind: "tool" as const, afterMessageCount: record.session.getMessages().length, createdAt: now };
    const overlayKey = `${record.id}\0${callId}`;
    if (type === "tool_result" || type === "tool_execution_end" || type === "function_result") {
      toolCallOverlay.delete(overlayKey);
      eventLog.append(record.id, { ...base, id: `bivy-tool-result-${callId}`, content: [{ type: "tool_result", toolUseId: callId, tool_use_id: callId, content: event.message ?? event.result ?? event.output ?? input.output ?? "", isError: Boolean(event.error || event.errorMessage), ...(event.detail ? { detail: event.detail } : {}) }] } as ToolActivityMessage);
    } else if (isProgressOnlyPing(type, event.detail, input)) {
      // A progress-only keep-alive (e.g. Claude's `tool_execution_update`
      // carrying just `{ elapsedSeconds }` and no `detail`) would otherwise
      // land under the same `bivy-tool-call-${callId}` key and overwrite the
      // original call's real input AND classification, so a reloaded transcript
      // renders the tool generically. The initiating `tool_call` already
      // recorded the overlay; the live stream still delivers the ping to open
      // clients, so dropping it from the persisted log loses nothing.
      return;
    } else {
      // Carry the delegation/sub-agent parent id onto the persisted tool_use
      // block so a reloaded transcript nests a sub-agent's calls under the
      // delegation that spawned them (toolEntriesFromContent → toolParentId),
      // exactly like the live stream does. Without this the parent id lived only
      // on the in-flight event and reopening a session flattened sub-agent work.
      // Generic: any runtime whose tool_call event names its parent nests —
      // `parentToolUseId` (Claude, protocol agents) or `parentToolCallId` (Pi's
      // nested calls from codemode / ctx.executeTool).
      const rawParent = event.parentToolUseId ?? event.parentToolCallId;
      const prior = toolCallOverlay.get(overlayKey);
      const parentToolUseId = typeof rawParent === "string" && rawParent ? rawParent : prior?.parentToolUseId;
      const detail = event.detail ?? prior?.detail;
      toolCallOverlay.set(overlayKey, { detail, parentToolUseId });
      eventLog.append(record.id, { ...base, id: `bivy-tool-call-${callId}`, content: [{ type: "tool_use", id: callId, name, input, ...(parentToolUseId ? { parentToolUseId } : {}), ...(detail ? { detail } : {}) }] } as ToolActivityMessage);
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

  function forkMessages(record: PersistSession): RuntimeMessage[] {
    return eventLog.deriveBase(record.id, record.session.getMessages());
  }

  function buildHistoryEvent(opts: BuildHistoryEventOptions): Record<string, unknown> {
    const described = withToolDetails(opts.messages, opts.runtimeId);
    const messages = opts.sessionId ? project(opts.sessionId, described) as unknown[] : described;
    const delta = historyDelta(messages, opts.cursor);
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
      events: outcome.mode === "replay" ? project(sessionId, outcome.events) : [],
    };
  }

  return {
    persistTranscriptSnapshot,
    persistToolActivityFromEvent,
    persistIntermediateFromEvent,
    resolveInlineImages,
    resolveWorkspaceRefs,
    conversationMessages,
    forkMessages,
    buildHistoryEvent,
    buildReplayEvent,
    clearLiveIntermediate,
  };
}
