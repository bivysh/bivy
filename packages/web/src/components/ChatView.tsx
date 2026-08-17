// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { stripAttachmentPlaceholders, toHtml, type PromptAttachment, type ToolActivity, type TranscriptEntry } from "@bivy/core";
import { ToolGroup } from "./ToolGroup.js";
import { Spinner } from "./Spinner.js";
import { ImageGallery } from "./ImageGallery.js";
import { decorateCodeBlocks, highlightCode } from "../highlight.js";
import { renderMermaidDiagrams } from "../mermaid.js";
import { writeClipboard } from "../clipboard.js";
import { getSpeechPreferences, markdownToSpeech, readAloudSupported, speechSynthesisSupported, speechToneInstructions } from "../speech.js";
import { controller } from "../store/useStore.js";
import { captureChatScroll, restoredChatScrollTop, type ChatScrollMemory } from "../chatScroll.js";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function base64ToBlobUrl(base64: string, mimeType: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  } catch {
    return null; // malformed base64 — fall back to a non-clickable chip
  }
}

/**
 * Resolve an attachment to a displayable blob URL. Two sources of bytes: inline
 * `data`/`text` (present on the client that just sent it), or — for an attachment
 * rehydrated from history — a content `hash` whose bytes are fetched from the
 * node's durable attachment store on demand. The hash path is what makes
 * attachments re-findable after a reload or on another device (see AttachmentStore
 * / controller.fetchAttachment). Returns null while a hash-only attachment is
 * still fetching, or if the bytes are unavailable. Shared by AttachmentChip and
 * the fullscreen ImageGallery.
 */
export function useAttachmentUrl(attachment: PromptAttachment | null | undefined): string | null {
  // Synchronous URL for inline content — bytes we already hold in memory.
  const inlineUrl = useMemo(() => {
    if (!attachment || attachment.omitted) return null;
    if (attachment.kind === "image" && attachment.data) return base64ToBlobUrl(attachment.data, attachment.mimeType);
    if (attachment.text !== undefined) {
      try {
        return URL.createObjectURL(new Blob([attachment.text], { type: attachment.mimeType || "text/plain" }));
      } catch {
        return null;
      }
    }
    return null;
  }, [attachment]);

  useEffect(() => {
    return () => {
      if (inlineUrl) URL.revokeObjectURL(inlineUrl);
    };
  }, [inlineUrl]);

  // Lazily fetch bytes for a hash-only attachment (rehydrated from history) and
  // turn them into a blob URL, revoking it on unmount / hash change.
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  useEffect(() => {
    setFetchedUrl(null);
    if (inlineUrl || !attachment || attachment.omitted || !attachment.hash) return;
    const mimeType = attachment.mimeType;
    let cancelled = false;
    let objectUrl: string | null = null;
    void controller.fetchAttachment(attachment.hash).then((res) => {
      if (cancelled || !res) return;
      objectUrl = base64ToBlobUrl(res.data, res.mimeType || mimeType);
      if (objectUrl) setFetchedUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [inlineUrl, attachment]);

  return inlineUrl ?? fetchedUrl;
}

/**
 * A single attachment the user sent with this message, shown as a clickable
 * thumbnail (image) or file chip so they can re-open what they attached. When an
 * `onOpenImage` handler is supplied, a plain left-click on an image launches the
 * in-app gallery instead of opening the raw blob in a new tab; modifier/middle
 * clicks still fall through to the `<a>` so "open in new tab" keeps working.
 */
function AttachmentChip({ attachment, onOpenImage }: { attachment: PromptAttachment; onOpenImage?: () => void }) {
  const url = useAttachmentUrl(attachment);

  if (attachment.kind === "image" && url) {
    return (
      <a
        className="msg-attachment image"
        href={url}
        target="_blank"
        rel="noopener"
        title={attachment.name}
        onClick={
          onOpenImage
            ? (e) => {
                // Leave new-tab gestures (cmd/ctrl/shift/middle-click) untouched.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenImage();
              }
            : undefined
        }
      >
        <img src={url} alt={attachment.name} />
      </a>
    );
  }
  const label = (
    <>
      <span className="attach-glyph">{attachment.kind === "image" ? "🖼" : "📄"}</span>
      <span className="attach-name">{attachment.name}</span>
      <span className="attach-size">{fmtBytes(attachment.size)}</span>
    </>
  );
  return url ? (
    <a className="msg-attachment file" href={url} download={attachment.name} title={`Open ${attachment.name}`}>
      {label}
    </a>
  ) : (
    <span className="msg-attachment file omitted" title="Content not available">
      {label}
    </span>
  );
}

/**
 * The row of attachment chips under a message, plus the fullscreen gallery its
 * image chips open. Owns the open/closed gallery state locally so paging stays
 * scoped to this message's images (the reader's chosen scope). Omitted images are
 * left out of the gallery set — they have no bytes to show.
 */
function MessageAttachments({ attachments }: { attachments: PromptAttachment[] }) {
  const images = useMemo(() => attachments.filter((a) => a.kind === "image" && !a.omitted), [attachments]);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  return (
    <div className="msg-attachments">
      {attachments.map((a, i) => {
        const imageIndex = images.indexOf(a);
        return (
          <AttachmentChip
            key={`${a.name}-${i}`}
            attachment={a}
            onOpenImage={imageIndex >= 0 ? () => setGalleryIndex(imageIndex) : undefined}
          />
        );
      })}
      {galleryIndex !== null && (
        <ImageGallery images={images} index={galleryIndex} onClose={() => setGalleryIndex(null)} />
      )}
    </div>
  );
}

// Friendly label for an inline notice action button. Falls back to the raw
// command so a newer node advertising an action this client doesn't know still
// renders something tappable.
function actionLabel(action: string): string {
  if (action === "/new") return "New session";
  if (action === "/resume") return "Resume";
  return `Run ${action}`;
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
}: {
  entry: TranscriptEntry;
  onAction?: (action: string) => void;
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
  // and hydrate any remote markdown images this entry now has a resolved ref
  // for (see TranscriptEntry.imageRefs / packages/core/src/markdown.ts). Re-runs
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
    const imgs = container.querySelectorAll<HTMLImageElement>("img.md-image[data-remote-src]");
    imgs.forEach((img) => {
      const url = img.dataset.remoteSrc;
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
  if (entry.role === "system")
    return (
      <div className="msg system">
        <span className="system-text" dangerouslySetInnerHTML={{ __html: toHtml(entry.text) }} />
        {entry.action && onAction && (
          <button type="button" className="btn sm primary" onClick={() => onAction(entry.action!)}>
            {actionLabel(entry.action)}
          </button>
        )}
      </div>
    );
  if (entry.role === "thinking")
    return <div className={`msg thinking${entry.streaming ? " streaming" : ""}`}>{entry.text}</div>;
  if (entry.role === "error")
    return (
      <div className="msg error" role="alert">
        <span className="msg-error-icon" aria-hidden>
          !
        </span>
        <span className="msg-error-text">{entry.text}</span>
      </div>
    );
  if (entry.role === "user") {
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
  return (
    <div className="assistant-row" id={hasAttachments ? `msg-${entry.id}` : undefined}>
      {hasAttachments && <MessageAttachments attachments={entry.attachments!} />}
      {(entry.text || !hasAttachments) && (
        <div ref={bodyRef} className="msg assistant" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {entry.text && (
        <div className="msg-actions">
          <CopyButton text={entry.text} />
          {readAloudSupported() && <SpeakButton text={entry.text} />}
        </div>
      )}
    </div>
  );
});

type RenderItem =
  | { kind: "entry"; key: string; entry: TranscriptEntry }
  | { kind: "tools"; key: string; tools: ToolActivity[] };

/**
 * Focus view: drop the interim chatter so the transcript reads as just the
 * conversation — user prompts, the agent's final answer for each turn, and any
 * system notice (errors, the inline "Create PR" action). "Interim" is the
 * agent's working-out: thinking blocks, tool-call cards, and the intermediate
 * assistant messages it emits between tool calls. Within each user-bounded
 * turn only the last assistant prose entry survives (the turn's conclusion); a
 * still-streaming reply is naturally that last entry, so it stays visible and
 * keeps updating. Pure filter over the array — the surviving entries keep their
 * object identity, so EntryView's memoization still skips unchanged rows.
 */
function collapseInterim(entries: TranscriptEntry[]): TranscriptEntry[] {
  const keep: TranscriptEntry[] = [];
  let lastAssistant: TranscriptEntry | null = null;
  const flush = () => {
    if (lastAssistant) keep.push(lastAssistant);
    lastAssistant = null;
  };
  for (const e of entries) {
    if (e.tool || e.role === "thinking") continue; // interim working-out
    if (e.role === "assistant") {
      lastAssistant = e; // hold; only the turn's last assistant prose is kept
      continue;
    }
    // user / system entry ends the current assistant run — emit the held final
    // assistant prose before it so ordering is preserved.
    flush();
    keep.push(e);
  }
  flush();
  return keep;
}

/** Stable React key for a tool-run group. Keyed on the first tool's runtime
 *  `callId` — NOT the transcript entry `id` — because reconciling a live turn
 *  with canonical history (store.applyHistory → renderHistory) rebuilds the
 *  whole transcript with freshly-generated entry ids. Keying on those made an
 *  open ToolGroup remount on every such reconcile, resetting its local `open`
 *  state and slamming the activity sheet shut mid-run. `callId` comes from the
 *  runtime and is preserved across re-renders, so the group — and any sheet the
 *  user opened on it — stays put until they close it themselves. Falls back to
 *  the entry id for the rare tool with no callId. */
function toolRunKey(first: TranscriptEntry): string {
  return `g:${first.tool?.callId || first.id}`;
}

/** Collapse runs of consecutive tool entries into a single grouped item. */
function groupEntries(entries: TranscriptEntry[]): RenderItem[] {
  const out: RenderItem[] = [];
  let run: TranscriptEntry[] | null = null;
  for (const e of entries) {
    if (e.tool) {
      if (!run) run = [];
      run.push(e);
    } else {
      if (run) {
        out.push({ kind: "tools", key: toolRunKey(run[0]!), tools: run.map((r) => r.tool!) });
        run = null;
      }
      out.push({ kind: "entry", key: e.id, entry: e });
    }
  }
  if (run) out.push({ kind: "tools", key: toolRunKey(run[0]!), tools: run.map((r) => r.tool!) });
  return out;
}

// Cap the number of live DOM nodes. A session can have thousands of messages;
// mounting (and markdown-rendering) them all is what makes a big session janky
// and slow to open. Open on just the most recent INITIAL_WINDOW entries, then
// reveal older history a page at a time on tap ("show earlier" below).
const INITIAL_WINDOW = 20;
const WINDOW_STEP = 40;

export function ChatView({
  entries,
  working,
  workingLabel,
  draftRoute,
  opening,
  sessionKey,
  collapsed,
  onAction,
  footer,
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
  /** Focus view: hide thinking, tool cards, and interim assistant messages —
   *  leaving user prompts, each turn's final answer, and system notices. */
  collapsed?: boolean;
  /** Run a slash command from an inline notice action button (e.g. "/new"). */
  onAction?: (action: string) => void;
  /** Rendered at the tail of the scroll area so approval/question cards flow
   *  inline with the transcript and scroll with it, rather than sitting in a
   *  pinned region between the chat and the composer. A newly-arrived card grows
   *  the content box, so the auto-follow layout-effect scrolls it into view on
   *  its own when the user is pinned to the bottom — no separate key needed. */
  footer?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [limit, setLimit] = useState(INITIAL_WINDOW);
  const scrollMemory = useRef(new Map<string, ChatScrollMemory>());
  const limitRef = useRef(limit);
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

  // In focus view the transcript is the interim-free projection; everything
  // downstream (windowing, auto-scroll, "show earlier" counts) operates on that
  // filtered list so the counts and the visible rows stay in agreement.
  const source = useMemo(() => (collapsed ? collapseInterim(entries) : entries), [collapsed, entries]);

  // Remember a session's distance from the bottom rather than its absolute
  // scrollTop. If content grows while it is in the background, returning still
  // lands on the same passage. A first visit starts at the latest message.
  const total = source.length;
  useLayoutEffect(() => {
    const remembered = scrollMemory.current.get(sessionKey ?? "new");
    const nextLimit = remembered?.limit ?? INITIAL_WINDOW;
    limitRef.current = nextLimit;
    setLimit(nextLimit);
    setPinnedState(remembered?.pinned ?? true);
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = restoredChatScrollTop(el, remembered);
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionKey, setPinnedState]);

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
    setLimit((current) => {
      const next = current + WINDOW_STEP;
      limitRef.current = next;
      return next;
    });
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

  const start = Math.max(0, total - limit);
  const visible = start > 0 ? source.slice(start) : source;
  const items = groupEntries(visible);

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scrollRef} onScroll={rememberScroll}>
        <div className="chat-inner" ref={contentRef}>
          {total === 0 && !draftRoute && opening && (
            <div className="chat-loading" role="status" aria-live="polite">
              <Spinner size="lg" />
              <p>Fetching transcript…</p>
            </div>
          )}
          {total === 0 && !draftRoute && !opening && (
            <div className="chat-empty">
              <p className="chat-empty-title">No messages yet</p>
              <p className="chat-empty-sub">
                This session has no transcript so far. Send a message below to
                continue, or open the terminal if it is running there.
              </p>
            </div>
          )}
          {total === 0 && draftRoute && (
            <div className="chat-empty">
              <p className="chat-empty-title">Start a new session</p>
              <p className="chat-empty-sub">
                Choose the <b>machine</b> to run on in the header, then the{" "}
                <b>agent</b> and <b>model</b> below. Describe your task to
                begin.
              </p>
              <p className="chat-empty-sub chat-empty-note">
                You can switch the model at any time, or hand off to a new
                agent to continue in a fresh session.
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
          {items.map((it) =>
            it.kind === "tools" ? (
              <ToolGroup key={it.key} tools={it.tools} />
            ) : (
              <EntryView key={it.key} entry={it.entry} onAction={onAction} />
            ),
          )}
          {working && (
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
