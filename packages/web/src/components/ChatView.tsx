// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyPlanUpdate, handoffSeedOf, looksLikeAuthFailure, planUpdateOf, stripAttachmentPlaceholders, toHtml, type PlanEntry, type TranscriptEntry } from "@bivy/core";
import { Spinner } from "./Spinner.js";
import { AppMessage } from "./AppMessage.js";
import { ReviewCard } from "./ReviewCard.js";
import { PinCard } from "./PinCard.js";
import { NoticeCard } from "./NoticeCard.js";
import { DelegationCard } from "./DelegationCard.js";
import { ToolGroup } from "./ToolGroup.js";
import { PlanCard } from "./PlanCard.js";
import { HandoffSeedLine } from "./HandoffSeedLine.js";
import { MessageAttachments } from "./AttachmentChip.js";
import { base64ToBlobUrl } from "../attachmentUrl.js";
import { MessageComponent, placementOf } from "./MessageComponent.js";
import { focusEntries } from "../focusTranscript.js";
import { clearMessageJump, pendingJumpIndex } from "../messageJump.js";
import { decorateCodeBlocks, highlightCode } from "../highlight.js";
import { renderMermaidDiagrams } from "../mermaid.js";
import { writeClipboard } from "../clipboard.js";
import { getSpeechPreferences, markdownToSpeech, readAloudSupported, speechSynthesisSupported, speechToneInstructions } from "../speech.js";
import { controller } from "../store/useStore.js";
import { captureChatScroll, restoredChatScrollTop, type ChatScrollMemory } from "../chatScroll.js";


// Friendly label for an inline notice action button. Falls back to the raw
// command so a newer node advertising an action this client doesn't know still
// renders something tappable.
function actionLabel(action: string): string {
  if (action === "/new") return "New session";
  if (action === "/resume") return "Resume";
  if (action === "fork") return "Fork to another agent";
  if (action === "cancel-resume") return "Cancel auto-retry";
  if (action === "fix-auth" || action.startsWith("fix-auth:")) return "Fix sign-in";
  if (action === "retry-auth") return "Refresh and retry";
  if (action.startsWith("connect-provider:")) return "Connect a provider";
  if (action.startsWith("retry-at-reset:")) return `Retry automatically at ${formatResetTime(action.slice("retry-at-reset:".length))}`;
  return `Run ${action}`;
}

/** A limit's reset instant in the viewer's local time — just the clock when it's
 *  today, with the weekday when it's further out (a weekly window). */
function formatResetTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "reset";
  const today = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Inline buttons for the actions a notice/error suggests. The first is the
 *  primary suggestion; any others are secondary alternatives. */
function EntryActions({ actions, onAction, size }: { actions?: string[]; onAction?: (action: string) => void; size?: "sm" }) {
  if (!actions?.length || !onAction) return null;
  return (
    <div className="entry-actions">
      {actions.map((action, i) => (
        <button key={action} type="button" className={["btn", size, i === 0 ? "primary" : ""].filter(Boolean).join(" ")} onClick={() => onAction(action)}>
          {actionLabel(action)}
        </button>
      ))}
    </div>
  );
}

/** Clipboard glyph (two overlapping sheets) — the resting state of a copy
 *  affordance. Shared look with the per-code-block button (see decorateCodeBlocks
 *  in highlight.ts), so "copy" reads the same everywhere. */
function CopyGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Checkmark shown briefly after a successful copy. */
function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Icon-only copy affordance for an assistant reply — copies the raw markdown
 * (not the rendered HTML) so pasting elsewhere keeps formatting like code
 * fences and lists intact. Hover-revealed on the row (see `.assistant-row` in
 * styles.css), always faintly visible on touch devices where hover doesn't
 * apply. Swaps to a checkmark for a moment on success.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(() => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <button
      type="button"
      className={`msg-copy-btn${copied ? " copied" : ""}`}
      onClick={onClick}
      title={copied ? "Copied" : "Copy message"}
      aria-label="Copy message"
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

/** Speaker glyph (cone + sound waves) — the resting state of the read-aloud
 *  affordance, styled to match CopyGlyph (stroked line-art, size 15). */
function SpeakGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

/** Stop glyph shown while a reply is being read aloud — tap to stop early. */
function StopGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

/** The one active reader across all message rows (browser or cloud audio). */
let stopActiveReader: (() => void) | null = null;

/** Icon-only read-aloud affordance for a final assistant reply. */
function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1; // invalidate an in-flight OpenAI request
    const utter = utterRef.current;
    if (utter) { utter.onend = null; utter.onerror = null; utterRef.current = null; }
    window.speechSynthesis.cancel();
    const cloud = audioRef.current;
    if (cloud) { cloud.audio.pause(); URL.revokeObjectURL(cloud.url); audioRef.current = null; }
    setSpeaking(false);
    if (stopActiveReader === stop) stopActiveReader = null;
  }, []);

  useEffect(() => stop, [stop]);

  const onClick = useCallback(async () => {
    if (speaking) { stop(); return; }
    const spoken = markdownToSpeech(text);
    if (!spoken) return;
    stopActiveReader?.();
    stopActiveReader = stop;
    setSpeaking(true);
    const prefs = getSpeechPreferences();

    if (prefs.reader === "openai") {
      const generation = ++generationRef.current;
      try {
        const result = await controller.synthesize(spoken, prefs.openaiVoice, speechToneInstructions(prefs.tone));
        if (generationRef.current !== generation) return;
        const url = base64ToBlobUrl(result.audio, result.mimeType);
        if (!url) throw new Error("The generated speech audio was invalid.");
        const audio = new Audio(url);
        audioRef.current = { audio, url };
        audio.onended = stop;
        audio.onerror = () => { controller.store.setError("Could not play the generated speech."); stop(); };
        await audio.play();
      } catch (error) {
        if (generationRef.current === generation) {
          controller.store.setError(error instanceof Error ? error.message : String(error));
          stop();
        }
      }
      return;
    }

    if (!speechSynthesisSupported()) {
      controller.store.setError("Browser speech is not supported on this device. Choose OpenAI under Settings → Voice.");
      stop();
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(spoken);
    utter.rate = prefs.rate;
    if (prefs.browserVoice) {
      utter.voice = synth.getVoices().find((voice) => voice.voiceURI === prefs.browserVoice || voice.name === prefs.browserVoice) ?? null;
    }
    const done = () => { if (utterRef.current === utter) stop(); };
    utter.onend = done;
    utter.onerror = done;
    utterRef.current = utter;
    synth.speak(utter);
  }, [speaking, stop, text]);

  return (
    <button
      type="button"
      className={`msg-speak-btn${speaking ? " speaking" : ""}`}
      onClick={onClick}
      title={speaking ? "Stop" : "Read aloud"}
      aria-label={speaking ? "Stop reading" : "Read message aloud"}
    >
      {speaking ? <StopGlyph /> : <SpeakGlyph />}
    </button>
  );
}

// Memoized so a streaming token that produces a new transcript array only
// re-renders the entries whose object identity actually changed. The store
// preserves references for untouched entries (map/spread keep them), so with a
// stable `entry` prop React skips the thousands of unchanged rows in a long
// session — the single biggest win for long-conversation rendering.
const EntryView = memo(function EntryView({
  entry,
  onAction,
  authAction,
}: {
  entry: TranscriptEntry;
  onAction?: (action: string) => void;
  /** What to offer when an error turns out to be a credential problem the entry
   *  itself couldn't name — see ChatView's prop of the same name. */
  authAction?: string;
}) {
  // Assistant prose is markdown. The store no longer renders it for the whole
  // transcript up front (that eager pass over every message is what made opening
  // a long session slow and blocking) — history entries arrive as plain `text`,
  // so we render markdown here. Because only the mounted window ever calls this,
  // the cost scales with what's on screen, not with the conversation length.
  // A finished assistant entry carries pre-rendered `html`; otherwise we render
  // its markdown here. A *streaming* assistant entry is shown as plain text and
  // is skipped entirely — running the markdown pass on every coalesced update is
  // the O(n²) churn the store avoids by not pre-rendering it (see previewPendingProse).
  // Hooks must run unconditionally, so this sits above the role branches; the
  // ternary keeps the (unused) markdown pass off streaming and non-assistant roles.
  const html = useMemo(
    () => (entry.role === "assistant" && !entry.streaming ? entry.html ?? toHtml(entry.text) : ""),
    [entry.role, entry.streaming, entry.html, entry.text],
  );
  // Syntax-highlight fenced code blocks once the assistant HTML is in the DOM,
  // and hydrate any markdown image this entry now has a resolved ref for —
  // remote or workspace-relative, both keyed by the reference the markdown wrote
  // (see TranscriptEntry.imageRefs / packages/core/src/markdown.ts). Re-runs
  // as streaming replaces the markup, AND when imageRefs grows live (a node
  // "inlineImage" event patches a new ref onto this entry with no text/html
  // change — see store.ts) so a just-resolved image hydrates without a reload.
  // All three helpers are idempotent against re-running on already-processed
  // DOM, so bundling them in one effect is safe either way.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (entry.role !== "assistant") return;
    renderMermaidDiagrams(bodyRef.current);
    highlightCode(bodyRef.current);
    decorateCodeBlocks(bodyRef.current);
    const container = bodyRef.current;
    if (!container || !entry.imageRefs) return;
    let cancelled = false;
    const created: string[] = [];
    const imgs = container.querySelectorAll<HTMLImageElement>("img.md-image[data-md-ref]");
    imgs.forEach((img) => {
      const url = img.dataset.mdRef;
      if (!url || img.dataset.hydrated === "1") return;
      const ref = entry.imageRefs?.[url];
      if (!ref) return; // not resolved yet — stays a placeholder until it is
      img.dataset.hydrated = "1";
      void controller.fetchAttachment(ref.hash).then((res) => {
        if (cancelled || !res) return;
        const blobUrl = base64ToBlobUrl(res.data, res.mimeType || ref.mimeType);
        if (blobUrl) {
          img.src = blobUrl;
          created.push(blobUrl);
        }
      });
    });
    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [entry.role, html, entry.imageRefs]);
  // Components the agent placed in this message (`::view{…}`, a ```bivy fence)
  // render as REAL React, portalled into the empty mount points the markdown
  // left behind — so a file renders as the same AttachmentChip the composer
  // produces instead of a second copy of that markup built as an HTML string.
  //
  // The mount points live inside dangerouslySetInnerHTML content, so they are
  // replaced wholesale whenever `html` changes. Collecting them in an effect
  // keyed on `html` is what keeps the portals pointed at live nodes: on a change
  // React swaps the markup, this re-runs, and the portals re-target. Nodes are
  // kept in state (not a ref) because rendering a portal is a render-time
  // decision.
  const [mounts, setMounts] = useState<HTMLElement[]>([]);
  useEffect(() => {
    if (entry.role !== "assistant" || !bodyRef.current) {
      setMounts((current) => (current.length ? [] : current));
      return;
    }
    const found = Array.from(bodyRef.current.querySelectorAll<HTMLElement>("div.md-component"));
    // Same-length-and-identity means the markup did not actually change; skip
    // the state write so this effect cannot drive a render loop.
    setMounts((current) => (current.length === found.length && current.every((n, i) => n === found[i]) ? current : found));
  }, [entry.role, html]);
  const components = mounts.map((node, i) => createPortal(
    <MessageComponent placement={placementOf(node)} refs={entry.imageRefs} />,
    node,
    `md-component-${i}`,
  ));
  if (entry.role === "system")
    return (
      <div className="msg system">
        <span className="system-text" dangerouslySetInnerHTML={{ __html: toHtml(entry.text) }} />
        <EntryActions actions={entry.actions} onAction={onAction} size="sm" />
      </div>
    );
  if (entry.role === "thinking")
    return <div className={`msg thinking${entry.streaming ? " streaming" : ""}`}>{entry.text}</div>;
  if (entry.role === "error") {
    const [summary = "The agent hit an error", ...detailLines] = entry.text.split("\n");
    const details = detailLines.join("\n").trim();
    // An auth failure the agent reported as plain text ("Failed to authenticate:
    // OAuth session expired…") carries no structured provider, so nothing points
    // the user at the one screen that fixes it. Offer the sign-in route whenever
    // the error reads like a credential problem and the node named no action of
    // its own. Refresh-and-retry sits beside it: the agent normally refreshes an
    // expired sign-in by itself, and a new turn re-reads the credential, so a
    // retry often recovers without signing in again.
    const actions = entry.actions?.length ? entry.actions : (authAction && looksLikeAuthFailure(entry.text) ? [authAction, "retry-auth"] : undefined);
    return (
      <div className="card transcript-error" data-tone="danger" role="alert">
        <strong>{summary}</strong>
        <EntryActions actions={actions} onAction={onAction} />
        {details && (
          <details className="settings-disclosure">
            <summary className="settings-disclosure-summary">Details</summary>
            <pre className="settings-disclosure-body">{details}</pre>
          </details>
        )}
      </div>
    );
  }
  if (entry.role === "user") {
    const seed = handoffSeedOf(entry.text);
    if (seed) return <HandoffSeedLine seed={seed} text={entry.text} />;
    const hasAttachments = !!entry.attachments && entry.attachments.length > 0;
    // With the attachments shown as thumbnails/chips, the node's appended
    // "[Image attachment: …]" placeholder lines are redundant — strip them so the
    // bubble reads the same as the optimistic one shown at send time (which never
    // had them). Kept verbatim when no attachment was recovered, so the reader
    // still sees that something was attached.
    const text = hasAttachments ? stripAttachmentPlaceholders(entry.text) : entry.text;
    return (
      <div className="msg user" id={hasAttachments ? `msg-${entry.id}` : undefined}>
        {hasAttachments && <MessageAttachments attachments={entry.attachments!} />}
        {text}
      </div>
    );
  }
  if (entry.streaming)
    // Live prose: plain text (whitespace preserved via .streaming-text) so it
    // updates cheaply; it seals into the markdown bubble below at message_end.
    return (
      <div className="assistant-row">
        <div ref={bodyRef} className="msg assistant streaming streaming-text">
          {entry.text}
        </div>
      </div>
    );
  // An agent-sent attachment (image/file) lands as an assistant entry carrying
  // `attachments` (and an optional caption in `text`). Render the chip(s) the same
  // way user uploads render, above any caption bubble. Reuses AttachmentChip, so
  // hash-only refs rehydrate their bytes on demand exactly like inbound ones.
  const hasAttachments = !!entry.attachments && entry.attachments.length > 0;
  const captionOnly = entry.attachments?.length === 1 && entry.attachments[0]?.description === entry.text;
  return (
    <div className="assistant-row" id={hasAttachments || entry.app || entry.review || entry.pin || entry.notice || entry.delegation ? `msg-${entry.id}` : undefined}>
      {entry.app && <AppMessage app={entry.app} />}
      {entry.review && <ReviewCard review={entry.review} />}
      {entry.pin && <PinCard pin={entry.pin} />}
      {entry.notice && <NoticeCard notice={entry.notice} />}
      {entry.delegation && <DelegationCard delegation={entry.delegation} />}
      {hasAttachments && <MessageAttachments attachments={entry.attachments!} />}
      {((entry.text && !captionOnly) || (!hasAttachments && !entry.app && !entry.review && !entry.pin && !entry.notice && !entry.delegation)) && (
        <div ref={bodyRef} className="msg assistant" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {components}
      {entry.text && !captionOnly && (
        <div className="msg-actions">
          <CopyButton text={entry.text} />
          {readAloudSupported() && <SpeakButton text={entry.text} />}
        </div>
      )}
    </div>
  );
});

type ToolEntry = NonNullable<TranscriptEntry["tool"]>;

type RenderItem =
  | { kind: "entry"; key: string; entry: TranscriptEntry }
  | { kind: "tools"; key: string; tools: ToolEntry[] }
  | { kind: "plan"; key: string; callId: string };

type RenderTurn = { kind: "turn"; key: string; user?: RenderItem; response: RenderItem[] };
type RenderBlock = RenderTurn | { kind: "standalone"; key: string; item: RenderItem };

/**
 * The wire transcript is entry-oriented, but people read it in turns. Group a
 * user prompt with everything that follows until the next prompt so thinking,
 * activity, the answer, and its actions share one visual rhythm. A window can
 * begin mid-turn, hence the response-only first group.
 */
function groupTurns(items: RenderItem[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let current: RenderTurn | null = null;
  for (const item of items) {
    const isUser = item.kind === "entry" && item.entry.role === "user";
    if (isUser) {
      current = { kind: "turn", key: `turn-${item.key}`, user: item, response: [] };
      blocks.push(current);
      continue;
    }
    // System notices and errors are session-level events, not agent prose. Keep
    // them in source order and outside the preceding conversation group.
    const standalone = item.kind === "entry" && (item.entry.role === "system" || item.entry.role === "error");
    if (standalone) {
      blocks.push({ kind: "standalone", key: `standalone-${item.key}`, item });
      current = null;
      continue;
    }
    if (!current) {
      current = { kind: "turn", key: `turn-${item.key}`, response: [] };
      blocks.push(current);
    }
    current.response.push(item);
  }
  for (const block of blocks) {
    if (block.kind !== "turn") continue;
    block.response = latestPlanOnly(block.response, block.key);
  }
  return blocks;
}

/** A top-level update to the agent's plan. A sub-agent's plan stays in its work group. */
function isPlanTool(tool: ToolEntry): boolean {
  return tool.detail?.kind === "plan" && !tool.parentToolUseId && planUpdateOf(tool.input) !== undefined;
}

/** The plan after each update, by call id. Folded over the whole transcript
 *  because a merge update (entries by id) builds on an earlier turn's plan. */
function planStates(entries: TranscriptEntry[]): Map<string, PlanEntry[]> {
  const states = new Map<string, PlanEntry[]>();
  let plan: PlanEntry[] = [];
  for (const entry of entries) {
    if (!entry.tool || !isPlanTool(entry.tool)) continue;
    plan = applyPlanUpdate(plan, planUpdateOf(entry.tool.input)!);
    states.set(entry.tool.callId, plan);
  }
  return states;
}

/** A turn shows its plan once, where it was last updated. Work groups that the
 *  dropped earlier updates split apart join back into one. The card is keyed by
 *  turn so it keeps its open/closed state as updates arrive. */
function latestPlanOnly(response: RenderItem[], turnKey: string): RenderItem[] {
  let last = -1;
  response.forEach((item, index) => { if (item.kind === "plan") last = index; });
  if (last < 0) return response;
  const out: RenderItem[] = [];
  response.forEach((item, index) => {
    if (item.kind === "plan" && index !== last) return;
    const previous = out[out.length - 1];
    if (item.kind === "tools" && previous?.kind === "tools") {
      out[out.length - 1] = { ...previous, tools: [...previous.tools, ...item.tools] };
      return;
    }
    out.push(item.kind === "plan" ? { ...item, key: `plan-${turnKey}` } : item);
  });
  return out;
}

/** Keep consecutive tool calls together while preserving their chronological
 * place among interim messages. This lets a live turn reveal meaningful work
 * as it happens instead of moving it above newer prose or hiding it until the
 * final answer arrives. */
function groupEntries(entries: TranscriptEntry[]): RenderItem[] {
  const items: RenderItem[] = [];
  let tools: ToolEntry[] = [];
  let key = "";
  const flush = () => {
    if (tools.length) items.push({ kind: "tools", key, tools });
    tools = [];
  };
  for (const entry of entries) {
    if (entry.tool && isPlanTool(entry.tool)) {
      flush();
      items.push({ kind: "plan", key: `plan-${entry.tool.callId}`, callId: entry.tool.callId });
    } else if (entry.tool) {
      if (!tools.length) key = `tools-${entry.tool.callId || entry.id}`;
      tools.push(entry.tool);
    } else {
      flush();
      items.push({ kind: "entry", key: entry.id, entry });
    }
  }
  flush();
  return items;
}

// Limit the initial mount, not the live transcript. Sliding this window on
// every append removes the passage being read and remounts tool groups (closing
// their inspectors). Keep its start fixed until the reader loads more history
// or switches sessions/views.
const INITIAL_WINDOW = 20;
const WINDOW_STEP = 40;

export function ChatView({
  entries,
  working,
  workingLabel,
  draftRoute,
  opening,
  sessionKey,
  focusView,
  onAction,
  authAction,
  header,
  footer,
  greeting,
}: {
  entries: TranscriptEntry[];
  working: boolean;
  workingLabel: string;
  /** The URL is the source of truth for whether this is a fresh draft. Only
   *  `/sessions/new` may show the start prompt; `/sessions/:id` always represents
   *  a real session whose empty transcript is still being fetched. */
  draftRoute: boolean;
  /** True while the store is waiting on the first history snapshot for the
   *  active session. Drives the "Fetching transcript…" spinner — must NOT be
   *  inferred from an empty entries array, or a legitimately empty session (or
   *  one whose history never arrives) spins forever. */
  opening?: boolean;
  /** Identity of the open session; used to preserve its window and reading position. */
  sessionKey: string | null;
  /** Show only user prompts, final assistant answers, and essential notices. */
  focusView?: boolean;
  /** Run a slash command from an inline notice action button (e.g. "/new"). */
  onAction?: (action: string) => void;
  /** The action that takes the user to the sign-in for this session's agent
   *  ("fix-auth[:provider]"), offered on a credential-shaped error the node
   *  didn't already attach an action to. */
  authAction?: string;
  /** Structured session startup state rendered before transcript entries. */
  header?: ReactNode;
  /** Rendered at the tail of the scroll area so approval/question cards flow
   *  inline with the transcript and scroll with it, rather than sitting in a
   *  pinned region between the chat and the composer. A newly-arrived card grows
   *  the content box, so the auto-follow layout-effect scrolls it into view on
   *  its own when the user is pinned to the bottom — no separate key needed. */
  footer?: ReactNode;
  /** Quiet headline centred on an empty draft (omitted during first-run
   *  onboarding, where the readiness checklist owns that space). */
  greeting?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const source = useMemo(() => focusView ? focusEntries(entries, working) : entries, [entries, focusView, working]);
  const total = source.length;
  const scrollMemory = useRef(new Map<string, ChatScrollMemory>());
  const [historyWindow, setHistoryWindow] = useState(() => ({
    sessionKey, focusView, initialized: total > 0, start: Math.max(0, total - INITIAL_WINDOW),
  }));
  // A refreshed/filtered transcript can shrink beneath the fixed cutoff. Keep
  // a tail of messages mounted, and persist the corrected cutoff so subsequent
  // appends cannot hide them again. Ordinary appends leave the window fixed.
  const latestStart = Math.max(0, total - INITIAL_WINDOW);
  let start = Math.min(historyWindow.start, latestStart);
  // Reset before committing a different session/view, or its first snapshot.
  // Ordinary appends must not move the start or change mounted group identities.
  if (historyWindow.sessionKey !== sessionKey || historyWindow.focusView !== focusView || (!historyWindow.initialized && total > 0)) {
    const remembered = scrollMemory.current.get(sessionKey ?? "new");
    start = Math.max(0, total - Math.max(INITIAL_WINDOW, remembered?.limit ?? INITIAL_WINDOW));
    setHistoryWindow({ sessionKey, focusView, initialized: total > 0, start });
  } else if (start !== historyWindow.start || (historyWindow.initialized && total === 0)) {
    setHistoryWindow({ ...historyWindow, initialized: total > 0, start });
  }
  // A message asked for from the Artifacts/Apps pages may sit above the window.
  const jumpIndex = pendingJumpIndex(sessionKey, source);
  if (jumpIndex !== null && jumpIndex < start) {
    start = jumpIndex;
    setHistoryWindow({ sessionKey, focusView, initialized: true, start });
  }
  const limitRef = useRef(total - start);
  useLayoutEffect(() => { limitRef.current = total - start; }, [total, start]);
  // Mirror `pinned` into a ref so the layout-effect and ResizeObserver below —
  // which run outside React's render cycle — can read the current value without
  // being re-subscribed on every scroll tick.
  const pinnedRef = useRef(true);
  const setPinnedState = useCallback((v: boolean) => {
    pinnedRef.current = v;
    setPinned(v);
  }, []);

  const atBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Snap to the bottom with no animation. Auto-follow must be instant: while a
  // turn streams, every chunk (tool card, working row, an assistant message
  // landing) grows the content, and a smooth scroll would start a fresh animation
  // toward a target that's already moved — the visible jitter, and the "blank gap
  // at the bottom, then a jump" the chat used to show. Instant keeps the newest
  // line glued just above the composer.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // The explicit "↓ Latest" affordance is a user gesture, so a smooth glide reads
  // as intentional (unlike the streaming auto-follow above).
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinnedState(true);
  }, [setPinnedState]);

  // Remember a session's distance from the bottom rather than its absolute
  // scrollTop. If content grows while it is in the background, returning still
  // lands on the same passage. A first visit starts at the latest message.
  useLayoutEffect(() => {
    const remembered = scrollMemory.current.get(sessionKey ?? "new");
    setPinnedState(remembered?.pinned ?? true);
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = restoredChatScrollTop(el, remembered);
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionKey, setPinnedState]);

  // Land on that message once it is mounted. Scheduled after the scroll
  // restore above, so it wins when the history was already cached.
  useLayoutEffect(() => {
    const index = pendingJumpIndex(sessionKey, source);
    if (index === null || index < start) return;
    const id = `msg-${source[index]!.id}`;
    clearMessageJump();
    setPinnedState(false);
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("is-jump-target");
      setTimeout(() => el.classList.remove("is-jump-target"), 2400);
    });
  }, [sessionKey, source, start, setPinnedState]);

  const rememberScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isPinned = atBottom();
    setPinnedState(isPinned);
    scrollMemory.current.set(
      sessionKey ?? "new",
      captureChatScroll(el, isPinned, limitRef.current),
    );
  }, [atBottom, sessionKey, setPinnedState]);

  const showEarlier = useCallback(() => {
    setHistoryWindow((current) => ({ ...current, start: Math.max(0, current.start - WINDOW_STEP) }));
  }, []);

  // Keep the view pinned to the newest line as content grows — streamed tool
  // cards, the working row, an assistant reply landing, an inline approval card.
  // This runs after every commit but before paint, so growth never flashes a gap
  // at the bottom or shunts the latest message off-screen. It only follows when
  // the user is already at the bottom (pinnedRef); scrolling up to read history is
  // never yanked back down. No dependency array on purpose: it must re-pin on
  // every render that changed layout, not just when a hand-picked field changes.
  useLayoutEffect(() => {
    if (pinnedRef.current) pinToBottom();
  });

  // Async layout that arrives without a React render — images decoding, code
  // blocks, web fonts settling — changes height after the effect above ran, which
  // would leave the newest line above the fold (the "empty space at the bottom"
  // symptom). Re-pin whenever the content box actually resizes while following.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) pinToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [pinToBottom]);

  const plans = useMemo(() => planStates(source), [source]);
  const visible = start > 0 ? source.slice(start) : source;
  const items = groupEntries(visible);
  const blocks = groupTurns(items);
  const tail = visible.at(-1);
  // Prose, streaming output, or a tool cluster already communicates progress;
  // reserve the generic dots for the gap before the agent emits anything.
  const tailShowsProgress = Boolean(tail?.role === "assistant" || tail?.tool);

  const renderItem = (it: RenderItem) => it.kind === "tools"
    ? <ToolGroup key={it.key} tools={it.tools} />
    : it.kind === "plan"
      ? plans.get(it.callId)?.length ? <PlanCard key={it.key} plan={plans.get(it.callId)!} /> : null
      : <EntryView key={it.key} entry={it.entry} onAction={onAction} authAction={authAction} />;

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scrollRef} onScroll={rememberScroll}>
        <div className="chat-inner" ref={contentRef}>
          {header}
          {total === 0 && !header && !draftRoute && opening && (
            <div className="chat-loading" role="status" aria-live="polite">
              <Spinner size="lg" />
              <p>Fetching transcript…</p>
            </div>
          )}
          {total === 0 && !header && draftRoute && greeting && (
            <div className="chat-greeting"><h2>{greeting}</h2></div>
          )}
          {total === 0 && !header && !draftRoute && !opening && (
            <div className="chat-empty">
              <p className="chat-empty-title">No messages yet</p>
              <p className="chat-empty-sub">
                This session has no transcript so far. Send a message below to
                continue, or open the terminal if it is running there.
              </p>
            </div>
          )}
          {start > 0 && (
            <button
              className="load-earlier"
              onClick={showEarlier}
            >
              ↑ Show earlier messages ({start} more)
            </button>
          )}
          {blocks.map((block) => block.kind === "standalone" ? (
            <div className="transcript-standalone" key={block.key}>{renderItem(block.item)}</div>
          ) : (
            <div className="transcript-turn" key={block.key}>
              {block.user?.kind === "entry" && <EntryView entry={block.user.entry} onAction={onAction} />}
              {block.response.length > 0 && <div className="turn-response-body">{block.response.map(renderItem)}</div>}
            </div>
          ))}
          {working && !tailShowsProgress && (
            <div className="working-row">
              <span className="working-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span className="working-label">{workingLabel || "working…"}</span>
            </div>
          )}
          {footer}
        </div>
      </div>
      {!pinned && total > 0 && (
        <button className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest">
          ↓ Latest
        </button>
      )}
    </div>
  );
}
