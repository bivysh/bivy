// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppState, PromptAttachment, SlashCommand } from "@bivy/core";
import { isSlashInput, parseSlash, matchSlashCommands, resolveSlash } from "@bivy/core";
import { useModalEscape } from "../modalStack.js";
import { RepoPicker, AgentPicker, ModelPicker, SandboxPicker } from "./Pickers.js";
import { firstSessionSummary } from "../firstSession.js";
import { FollowupQueue } from "./FollowupQueue.js";
import { SANDBOX_TIERS } from "./sandboxTiers.js";
import { VoiceRecorder } from "./VoiceRecorder.js";
import { Spinner } from "./Spinner.js";
import { WebSpeechRecorder, webSpeechSupported } from "./WebSpeechRecorder.js";
import { controller } from "../store/useStore.js";
import { clearComposerDraft, composerDraftKey, readComposerDraft, writeComposerDraft, type PendingAttachmentMetadata } from "../composerDraft.js";
import { setComposerLifecycle } from "../pwaLifecycle.js";

type Picker = "repo" | "agent" | "model" | "sandbox" | null;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENTS_BYTES = 40 * 1024 * 1024;
const TEXT_ATTACHMENT_BYTES = 512 * 1024;
const TEXT_EXT = /\.(md|txt|json|ya?ml|csv|ts|tsx|js|jsx|css|html|xml|py|rb|go|rs|java|c|cpp|h|hpp|sh|sql)$/i;

function readDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function readText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

// Mirrors the app's own mobile breakpoint (styles.css: `.only-mobile`, the
// drawer-sidebar media query). On a phone, Enter should behave like every
// native messaging app — insert a newline — since there's no keyboard
// modifier available to distinguish "send" from "new line" and the on-screen
// send button is always one tap away. Desktop keeps Enter=send/Shift+Enter=
// newline.
function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
}

/** Whether it's safe to programmatically move focus into the composer. Agent
 *  activity churns `disabled` and re-renders, which fires the composer's refocus
 *  effects; if the user is meanwhile typing in another field (e.g. a Settings
 *  search/input rendered in a portal above the app) we must NOT yank the caret
 *  out from under them. Only steal focus when nothing editable — and no open
 *  dialog — currently owns it. */
function canGrabFocus(target: HTMLElement | null): boolean {
  if (typeof document === "undefined") return true;
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === target) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return false;
  // A modal/dialog (Settings, pickers, terminal overlay) owns focus — leave it.
  if (el.closest?.('[role="dialog"], .settings-modal')) return false;
  return true;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Reconstruct a displayable data URL from an image attachment's raw base64
 *  (the composer strips the `data:` prefix at read time). */
function imageDataUrl(a: PromptAttachment): string | null {
  if (a.kind !== "image" || !a.data) return null;
  return `data:${a.mimeType || "image/png"};base64,${a.data}`;
}

/** A drag carrying real files (not just text/links) — so we only light up the
 *  drop zone for actual file drops. */
function hasFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types || []).includes("Files"));
}

function GhGlyph() {
  return (
    <svg className="pill-gh" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15.5a3 3 0 003-3V6a3 3 0 10-6 0v6.5a3 3 0 003 3z" />
      <path d="M6 11.5v1a6 6 0 0012 0v-1M12 18.5V21M9 21h6" />
    </svg>
  );
}

/** Line-art paperclip that matches MicGlyph's stroked style (same viewBox,
 *  weight and rounded caps) instead of the mismatched 📎 emoji. */
export function AttachGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

function ModelGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" /><path d="m18.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </svg>
  );
}

export function Composer({
  state,
  disabled,
  disabledHint,
  working,
  onSend,
  onAbort,
  onError,
}: {
  state: AppState;
  disabled: boolean;
  disabledHint?: string;
  working: boolean;
  onSend: (text: string, attachments?: PromptAttachment[]) => void;
  onAbort: () => void;
  onError?: (message: string) => void;
}) {
  const initialDraft = useRef<ReturnType<typeof readComposerDraft> | null>(null);
  if (!initialDraft.current) initialDraft.current = readComposerDraft(localStorage, state.activeSession.activeSessionId);
  const [text, setText] = useState(() => initialDraft.current?.text ?? "");
  const [picker, setPicker] = useState<Picker>(null);
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [recoveredAttachments, setRecoveredAttachments] = useState<PendingAttachmentMetadata[]>(() => initialDraft.current?.attachments ?? []);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [recording, setRecording] = useState<null | "server" | "webspeech">(null);
  const [dragging, setDragging] = useState(false);
  // Reading a large/multiple file(s) (base64-encoding images, slurping text)
  // can take a visible moment with zero prior feedback — the paperclip button
  // just sat there looking unresponsive. Tracks a plain count so multiple
  // concurrent picks (unlikely, but the file input allows it) don't clobber
  // each other's "done" transition.
  const [readingCount, setReadingCount] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const dragDepth = useRef(0);

  // Some runtimes (e.g. Codex / Codex approvals) own model selection themselves
  // and expose no in-app model list — advertised via
  // `capabilities.modelSelection === false`. Keep the model pill visible (it
  // shows the default-model label) but disable it for those agents so clicking
  // never opens a picker that can only ever say "No models available." Anything
  // not explicitly false (including runtimes that haven't loaded yet) stays
  // interactive, so we never disable it for a capable agent.
  const currentRuntime = state.catalogs.runtimes.find((r) => r.id === (state.activeSession.activeRuntimeId ?? state.catalogs.selectedAgentId));
  const currentCaps = currentRuntime?.capabilities as
    | { modelSelection?: boolean; commands?: SlashCommand[] }
    | undefined;
  const modelSelectable = currentCaps?.modelSelection !== false;
  // The active agent's own slash commands (e.g. Claude Code's `/compact`). These
  // are advertised PER SESSION (session.created / session.capabilities → the
  // store's commandsBySession), so we read the *active session's* set — never a
  // shared runtime row, which two sessions on the same runtime would clobber.
  // For a pre-session draft there's no session yet, so we fall back to the
  // selected runtime's static catalog commands (e.g. a shim's seeded set). They
  // join the composer's autocomplete and, when invoked, are either forwarded to
  // the agent as a prompt (mode "prompt") or dispatched via command.invoke
  // (mode "protocol") rather than run as a Bivy control command.
  const sessionCommands = state.activeSession.activeSessionId ? state.sessionIndex.commandsBySession[state.activeSession.activeSessionId] : undefined;
  const runtimeCommands: SlashCommand[] = Array.isArray(currentCaps?.commands) ? currentCaps.commands : [];
  const agentCommands: SlashCommand[] = sessionCommands ?? (state.activeSession.activeSessionId ? [] : runtimeCommands);
  // Follow-ups held back while this session is busy (or while earlier ones are
  // still waiting) — see AppController.sendPrompt/mustQueue. Only ever
  // populated for a real (non-draft) session.
  const followups = state.activeSession.activeSessionId ? state.sessionIndex.followupsBySession[state.activeSession.activeSessionId] ?? [] : [];
  // Whether the active runtime has advertised it can safely take an explicit
  // mid-turn interrupt — gates the "Steer current turn" affordance below.
  const canSteer = controller.supportsSteering();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isDraft = !state.activeSession.activeSessionId;
  const activeDraftKey = useRef(composerDraftKey(state.activeSession.activeSessionId));
  const activeDraftSession = useRef(state.activeSession.activeSessionId);
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  const recoveredRef = useRef(recoveredAttachments);
  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { recoveredRef.current = recoveredAttachments; }, [recoveredAttachments]);

  // Persist text plus byte-less attachment metadata per Session. File bytes and
  // extracted text deliberately stay in memory; after reload the user sees what
  // was pending and must re-select the files before sending.
  useEffect(() => {
    const nextKey = composerDraftKey(state.activeSession.activeSessionId);
    if (activeDraftKey.current === nextKey) return;
    writeComposerDraft(localStorage, activeDraftSession.current, textRef.current, [
      ...attachmentsRef.current,
      ...recoveredRef.current as PromptAttachment[],
    ]);
    const saved = readComposerDraft(localStorage, state.activeSession.activeSessionId);
    setText(saved.text);
    setAttachments([]);
    setRecoveredAttachments(saved.attachments);
    setMenuDismissed(false);
    setMenuIndex(0);
    requestAnimationFrame(autosize);
    activeDraftKey.current = nextKey;
    activeDraftSession.current = state.activeSession.activeSessionId;
  }, [state.activeSession.activeSessionId]);

  useEffect(() => {
    writeComposerDraft(localStorage, activeDraftSession.current, text, [
      ...attachments,
      ...recoveredAttachments as PromptAttachment[],
    ]);
    setComposerLifecycle({
      hasDraft: Boolean(text.trim()),
      pendingAttachments: attachments.length + recoveredAttachments.length,
      readingAttachments: readingCount > 0,
    });
  }, [text, attachments, recoveredAttachments, readingCount]);

  useEffect(() => () => setComposerLifecycle({ hasDraft: false, pendingAttachments: 0, readingAttachments: false }), []);

  // Keep the textarea height in sync with its content on EVERY text change, not
  // just keystrokes. Programmatic updates — restoring a saved draft, or the long
  // handoff summary an agent switch drops into a fresh draft — set `text` without
  // an onChange, so without this they'd render collapsed to a single row. A
  // layout effect measures after the DOM commit (so scrollHeight is correct) and
  // before paint (so there's no single-line flash).
  useLayoutEffect(() => {
    autosize();
  }, [text]);

  // Publish the composer's live height as --composer-h so bottom sheets (tool
  // activity, pickers) can reserve that strip and never tuck their lower rows
  // behind the input. The composer grows with multi-line text and attachment
  // chips, so we track it rather than hard-code a guess.
  useEffect(() => {
    const el = formRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--composer-h", `${Math.round(el.offsetHeight)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--composer-h");
    };
  }, []);

  // Preserve the caret across a disable→enable flip. If the connection drops all
  // the way to offline the textarea disables, and the browser blurs a disabled
  // field — so without this the composer silently loses focus mid-thought and the
  // user has to tap back in once it recovers. We remember that they were typing
  // (intent survives the disable-induced blur, which never clears it) and restore
  // focus the instant the field is typable again.
  const wantsFocusRef = useRef(false);
  useEffect(() => {
    if (!disabled && wantsFocusRef.current && canGrabFocus(taRef.current)) taRef.current?.focus();
  }, [disabled]);

  // Starting a new session (the sidebar "+ New" button or the "/new" command)
  // should drop the cursor straight into the composer so the user can type
  // immediately. The controller fires this after resetting to a fresh draft.
  useEffect(() => {
    return controller.onComposerFocus(() => {
      // Remember the intent so a disable→enable flip (offline blip) refocuses too.
      wantsFocusRef.current = true;
      requestAnimationFrame(() => {
        if (canGrabFocus(taRef.current)) taRef.current?.focus();
      });
    });
  }, []);

  // Contextual actions draft text instead of silently spending an agent turn.
  // Append rather than replace so an in-progress thought is never discarded.
  useEffect(() => {
    return controller.onComposerPrefill((draft) => {
      const clean = draft.trim();
      if (!clean) return;
      setText((previous) => previous.trim() ? `${previous.trimEnd()}\n\n${clean}` : clean);
      setMenuDismissed(false);
      wantsFocusRef.current = true;
      requestAnimationFrame(() => {
        autosize();
        const input = taRef.current;
        if (!canGrabFocus(input)) return;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });
    });
  }, []);

  // The "/" pill (top-right, above the composer) asks us to open the slash-command
  // menu. Seed a lone "/" so matchSlashCommands lists every advertised command,
  // clear any prior dismissal, and focus the input — the menu renders reactively,
  // so a session whose commands are still arriving (a just-reopened one) fills in
  // as soon as they land. Preserve a command the user was already mid-typing.
  useEffect(() => {
    return controller.onOpenSlash(() => {
      setText((prev) => (prev.trimStart().startsWith("/") ? prev : "/"));
      setMenuDismissed(false);
      setMenuIndex(0);
      wantsFocusRef.current = true;
      requestAnimationFrame(() => {
        autosize();
        if (canGrabFocus(taRef.current)) taRef.current?.focus();
      });
    });
  }, []);

  // Escape closes the image viewer — coordinated through the shared modal stack
  // so only the topmost open layer responds (matches the pickers/sheets).
  useModalEscape(() => setViewing(null), Boolean(viewing));

  // Pull the voice-input config once so we can point the user at Settings when
  // they try to dictate with no provider key stored, instead of prompting for
  // the mic and then failing.
  useEffect(() => {
    if (!disabled && !state.settings.sttConfig) controller.getSttConfig();
  }, [disabled, state.settings.sttConfig]);
  const voiceReady = Boolean(state.settings.sttConfig?.providers.some((p) => p.configured));

  // Pick the transcription engine: a stored provider key routes audio through
  // the node (best quality); otherwise fall back to the browser's built-in Web
  // Speech dictation (no key, no cost). Only error when neither is available.
  function startRecording() {
    if (disabled) return;
    if (voiceReady || !state.settings.sttConfig) setRecording("server");
    else if (webSpeechSupported()) setRecording("webspeech");
    else onError?.("Add a Groq or OpenAI key in Settings → Voice input to use voice input.");
  }

  // Drop the transcript into the composer at the caret (or append), then refocus.
  function insertTranscript(transcript: string) {
    const clean = transcript.trim();
    if (!clean) return;
    setText((prev) => {
      const needsSpace = prev && !/\s$/.test(prev);
      return `${prev}${needsSpace ? " " : ""}${clean}`;
    });
    requestAnimationFrame(() => {
      autosize();
      taRef.current?.focus();
    });
  }

  // The slash-command autocomplete list, shown while the user is still typing
  // the command word (no space yet) and hasn't dismissed it with Escape.
  const slashMenu = !disabled && !menuDismissed ? matchSlashCommands(text, agentCommands) : [];
  // Whether the user is in the command word (typed "/" with no space yet), so we
  // can show an empty-state instead of silence when nothing matches — otherwise
  // an agent that advertises no commands (e.g. Codex) looks like it has no slash
  // support at all, and a typo just vanishes with no feedback.
  const inSlashWord = (() => {
    if (disabled || menuDismissed) return false;
    const p = text.trimStart();
    return p.startsWith("/") && !/\s/.test(p);
  })();
  const slashEmpty = inSlashWord && slashMenu.length === 0;

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  async function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setReadingCount((n) => n + 1);
    try {
      const next: PromptAttachment[] = [];
      let acceptedBytes = attachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0);
      let acceptedCount = attachments.length;
      for (const file of Array.from(files)) {
        if (acceptedCount >= MAX_ATTACHMENTS) {
          onError?.(`A message can include at most ${MAX_ATTACHMENTS} attachments.`);
          break;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          onError?.(`${file.name} is larger than ${fmtBytes(MAX_ATTACHMENT_BYTES)} and was not attached.`);
          continue;
        }
        if (acceptedBytes + file.size > MAX_ATTACHMENTS_BYTES) {
          onError?.(`Attachments are limited to ${fmtBytes(MAX_ATTACHMENTS_BYTES)} per message.`);
          continue;
        }
        acceptedBytes += file.size;
        acceptedCount += 1;
        try {
          if (file.type.startsWith("image/")) {
            const url = await readDataUrl(file);
            const data = url.includes(",") ? url.split(",").pop() || "" : url;
            next.push({ kind: "image", name: file.name, size: file.size, mimeType: file.type || "image/png", data });
            continue;
          }
          const isText = file.type.startsWith("text/") || TEXT_EXT.test(file.name);
          if (!isText) {
            // Any non-text file (binary, PDF, .pem, …): send the raw bytes as
            // base64 so the node can materialize it on disk for the agent to
            // read. Previously these were dropped with `omitted: true`.
            const url = await readDataUrl(file);
            const data = url.includes(",") ? url.split(",").pop() || "" : url;
            next.push({ kind: "file", name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", data });
            continue;
          }
          const body = await readText(file);
          next.push({
            kind: "file",
            name: file.name,
            size: file.size,
            mimeType: file.type || "text/plain",
            text: body.slice(0, TEXT_ATTACHMENT_BYTES),
            truncated: body.length > TEXT_ATTACHMENT_BYTES,
          });
        } catch {
          acceptedBytes -= file.size;
          acceptedCount -= 1;
          onError?.(`Could not read ${file.name}.`);
        }
      }
      if (next.length) {
        setAttachments((prev) => [...prev, ...next]);
        setRecoveredAttachments((previous) => previous.filter((metadata) => !next.some((attachment) => attachment.name === metadata.name)));
      }
      if (fileRef.current) fileRef.current.value = "";
    } finally {
      setReadingCount((n) => Math.max(0, n - 1));
    }
  }

  function removeAttachment(i: number) {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }

  function clearComposer() {
    clearComposerDraft(localStorage, activeDraftSession.current);
    setText("");
    setAttachments([]);
    setRecoveredAttachments([]);
    setMenuDismissed(false);
    setMenuIndex(0);
    requestAnimationFrame(autosize);
  }

  // Invoke an advertised agent-native command. A "protocol"-mode command routes
  // through the dedicated command.invoke channel; a "prompt"-mode command (the
  // default, used by Pi/Claude) is forwarded as an ordinary prompt so the agent's
  // own parser runs it.
  function invokeAgentCommand(cmd: SlashCommand, args: string): void {
    if (cmd.mode === "protocol") controller.invokeAgentCommand(cmd.name, args);
    else onSend(args ? `${cmd.name} ${args}` : cmd.name);
  }

  function chooseFromMenu(cmd: SlashCommand) {
    // Every menu entry is an agent-native command; it may take arguments (e.g.
    // "/model sonnet"), so we drop "/name " into the composer and keep focus
    // rather than firing it blind.
    setText(`${cmd.name} `);
    setMenuDismissed(true);
    setMenuIndex(0);
    requestAnimationFrame(() => {
      autosize();
      taRef.current?.focus();
    });
  }

  function submit() {
    const value = text.trim();
    if ((!value && !attachments.length) || disabled) return;
    // Dispatch a slash line (see resolveSlash): an advertised agent command is
    // invoked. An unknown slash is rejected with feedback WHEN the active session
    // advertised a command catalog — otherwise we stay permissive and forward the
    // raw line (older runtimes that parse slashes themselves rely on this).
    if (isSlashInput(value)) {
      const parsed = parseSlash(value);
      if (parsed) {
        const res = resolveSlash(parsed, agentCommands);
        if (res.kind === "agent") { invokeAgentCommand(res.command, res.args); clearComposer(); return; }
        if (res.hasCatalog) {
          onError?.(`Unknown command ${res.name}. Type / to see this agent's commands.`);
          return;
        }
        // No catalog advertised — fall through and forward the raw slash line.
      }
    }
    onSend(value, attachments.length ? attachments : undefined);
    setText("");
    setAttachments([]);
    requestAnimationFrame(autosize);
  }

  const modelLabel = state.catalogs.currentModel?.label || state.catalogs.currentModel?.id || "Default";
  // The repo pill also carries the chosen remote branch (#466) — picked from
  // the arrow on a repo row in the repo picker, not a separate pill. A blank
  // branch means "the repo's default branch", so we only append "@ <branch>"
  // when a specific one was chosen.
  const repoLabel = state.draft.repo
    ? state.draft.branch
      ? `${state.draft.repo} @ ${state.draft.branch}`
      : state.draft.repo
    : "No repo";
  const repoTitle = state.draft.repo
    ? state.draft.branch
      ? `Repository ${state.draft.repo} (branch ${state.draft.branch})`
      : `Repository ${state.draft.repo} (default branch)`
    : "Repository";
  // The next session's sandbox tier: an explicit draft choice, else the node
  // default (shown by name when known). Chosen up front on the draft; a running
  // session shows it read-only in Session settings.
  const draftTier = SANDBOX_TIERS.find((t) => t.id === state.draft.sandbox);
  const nodeDefaultTier = SANDBOX_TIERS.find((t) => t.id === state.settings.nodeSettings?.defaultSandbox);
  // The ◈ glyph already reads as "sandbox", so we drop the redundant "Sandbox"
  // word: show the chosen tier, else the node default's name, else glyph only.
  const sandboxLabel = draftTier
    ? draftTier.label
    : nodeDefaultTier
      ? nodeDefaultTier.label
      : state.settings.nodeSettings?.defaultSandbox ?? "";
  const sandboxTitle = draftTier ? draftTier.hint : "Sandbox mode for this session (machine default)";
  const canSend = !disabled && (Boolean(text.trim()) || attachments.length > 0);
  // B2 — a first session exposes exactly four decisions: machine, repo,
  // agent/model, protection. On a draft we render a single explicit summary of
  // them (the machine otherwise lives only in the topbar switcher), so a new user
  // sees the whole decision set at a glance rather than inferring it from pills.
  const machineLabel = state.connection.nodes.find((n) => n.id === state.connection.currentNodeId)?.name
    || (controller.direct ? "This machine" : "Default machine");
  const firstSessionLine = firstSessionSummary({
    machine: machineLabel,
    repo: state.draft.repo || "No repo",
    agent: state.catalogs.currentAgentName || "Agent",
    model: modelLabel,
    modelManagedByAgent: !modelSelectable,
    protection: sandboxLabel || state.draft.sandbox || undefined,
  });
  const firstIsolatedRun = isDraft && Boolean(state.draft.ephemeralConfig);
  const starterTask = "Inspect this repository and explain how to run its tests. Do not change files.";

  return (
    <>
      {isDraft && (
        <div className="composer-first-session" title="A first session decides just four things: machine, repository, agent/model, and protection.">
          Starting on <span className="fs-decisions">{firstSessionLine}</span>
        </div>
      )}
      {firstIsolatedRun && !text.trim() && attachments.length === 0 && (
        <div className="composer-starter" role="note">
          <div>
            <strong>Start with a safe read-only task</strong>
            <span>Verify the Machine, repository, agent, and model before asking it to edit code.</span>
          </div>
          <button type="button" className="btn small" onClick={() => setText(starterTask)}>
            Use starter task
          </button>
        </div>
      )}
      {isDraft && (
        <div className="composer-lead">
          <button type="button" className="pill repo-pill" onClick={() => setPicker("repo")} title={repoTitle}>
            <GhGlyph />
            <span className="pill-label">{repoLabel}</span>
          </button>
          <button type="button" className="pill sandbox-pill" onClick={() => setPicker("sandbox")} title={sandboxTitle} aria-label="Sandbox mode">
            <span className="pill-glyph">◈</span>
            {sandboxLabel && <span className="pill-label">{sandboxLabel}</span>}
          </button>
        </div>
      )}
      {state.activeSession.activeSessionId && (
        <FollowupQueue
          sessionId={state.activeSession.activeSessionId}
          items={followups}
          canSteer={canSteer}
          busy={working}
          onError={onError}
        />
      )}
      <form
        ref={formRef}
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          className={`composer-card${dragging ? " dragging" : ""}`}
          onDragEnter={(e) => {
            if (disabled || !hasFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (disabled || !hasFiles(e.dataTransfer)) return;
            e.preventDefault(); // required so the browser fires `drop` here
          }}
          onDragLeave={() => {
            if (dragDepth.current === 0) return;
            dragDepth.current -= 1;
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            if (disabled || !hasFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          {dragging && (
            <div className="composer-drop" aria-hidden>
              <span>Drop files to attach</span>
            </div>
          )}
          {slashMenu.length > 0 && (
            <div className="menu slash-menu" role="listbox" aria-label="Commands">
              {slashMenu.map((cmd, i) => {
                const activeIndex = Math.min(menuIndex, slashMenu.length - 1);
                return (
                <button
                  type="button"
                  key={cmd.name}
                  className={`menu-item slash-item${i === activeIndex ? " active" : ""}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  // onMouseDown (not onClick) so the textarea doesn't blur and
                  // swallow the tap before the handler runs.
                  onMouseDown={(e) => { e.preventDefault(); chooseFromMenu(cmd); }}
                >
                  <span className="slash-name">{cmd.name}</span>
                  <span className="slash-desc">{cmd.description}</span>
                </button>
                );
              })}
            </div>
          )}
          {slashEmpty && (
            <div className="menu slash-menu slash-empty" role="status">
              {agentCommands.length === 0
                ? "This agent has no slash commands."
                : "No matching command — press Esc to send as a message."}
            </div>
          )}
          {recoveredAttachments.length > 0 && (
            <div className="attachment-recovery" role="status">
              <span>Reload preserved metadata for {recoveredAttachments.map((attachment) => attachment.name).join(", ")}, not file contents. Re-select before sending.</span>
              <button type="button" className="btn ghost" onClick={() => setRecoveredAttachments([])}>Clear</button>
            </div>
          )}
          {(attachments.length > 0 || readingCount > 0) && (
            <div className="attach-chips">
              {readingCount > 0 && (
                <span className="attach-chip reading" aria-live="polite">
                  <Spinner size="xs" />
                  Reading file{readingCount > 1 ? "s" : ""}…
                </span>
              )}
              {attachments.map((a, i) => {
                const thumb = imageDataUrl(a);
                return (
                  <span key={`${a.name}-${i}`} className={`attach-chip${a.omitted ? " omitted" : ""}${thumb ? " has-thumb" : ""}`} title={a.omitted ? "File could not be read — not attached" : a.name}>
                    {thumb ? (
                      <button type="button" className="attach-thumb-btn" onClick={() => setViewing(thumb)} aria-label={`View ${a.name}`} title={`View ${a.name}`}>
                        <img className="attach-thumb" src={thumb} alt={a.name} />
                      </button>
                    ) : (
                      <span className="attach-glyph">{a.kind === "image" ? "🖼" : "📄"}</span>
                    )}
                    <span className="attach-name">{a.name}</span>
                    <button type="button" className="attach-remove" onClick={() => removeAttachment(i)} aria-label={`Remove ${a.name}`}>
                      ✕
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {recording === "server" && (
            <VoiceRecorder
              transcribe={(audio, mime) => controller.transcribe(audio, mime)}
              onResult={insertTranscript}
              onCancel={() => setRecording(null)}
              onError={(m) => onError?.(m)}
            />
          )}
          {recording === "webspeech" && (
            <WebSpeechRecorder
              onResult={insertTranscript}
              onCancel={() => setRecording(null)}
              onError={(m) => onError?.(m)}
            />
          )}
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={disabled ? disabledHint || "Connecting…" : firstIsolatedRun ? "Describe your first task…" : "Message your agent…"}
            rows={1}
            hidden={Boolean(recording)}
            value={text}
            disabled={disabled}
            onFocus={() => { wantsFocusRef.current = true; }}
            // A genuine user blur clears the intent; a disable-induced blur leaves
            // `disabled` true here, so we keep the intent and refocus on recovery.
            onBlur={() => { if (!disabled) wantsFocusRef.current = false; }}
            onPaste={(e) => {
              // Pasted images (screenshots) attach like a drop; text pastes fall
              // through to the default textarea behaviour.
              const files = e.clipboardData?.files;
              if (files && files.length && Array.from(files).some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onChange={(e) => {
              setText(e.target.value);
              setMenuDismissed(false);
              setMenuIndex(0);
              autosize();
            }}
            onKeyDown={(e) => {
              // While the slash menu is open, arrows move the highlight and
              // Enter/Tab accept it — so a command is one keystroke to run.
              if (slashMenu.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((i) => Math.min(i + 1, slashMenu.length - 1)); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex((i) => Math.max(i - 1, 0)); return; }
                if (e.key === "Escape") { e.preventDefault(); setMenuDismissed(true); return; }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  const cmd = slashMenu[Math.min(menuIndex, slashMenu.length - 1)];
                  if (cmd) chooseFromMenu(cmd);
                  return;
                }
              }
              if (e.key !== "Enter" || e.shiftKey) return;
              if (isMobileViewport()) return; // let Enter insert a newline; tap Send to submit
              e.preventDefault();
              submit();
            }}
          />
          <div className="composer-actions" hidden={Boolean(recording)}>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void addFiles(e.target.files)}
            />
            <div className="composer-meta">
              <button
                type="button"
                className="pill attach-pill"
                onClick={() => fileRef.current?.click()}
                disabled={disabled}
                title="Attach files"
                aria-label="Attach files"
              >
                <span className="pill-glyph"><AttachGlyph /></span>
              </button>
              <button type="button" className="pill agent-pill" onClick={() => setPicker("agent")} title="Agent">
                <span className="pill-glyph"><AgentGlyph /></span>
                <span className="pill-label">{state.catalogs.currentAgentName || "Agent"}</span>
              </button>
              <button
                type="button"
                className="pill model-pill"
                onClick={() => { if (modelSelectable) setPicker("model"); }}
                disabled={!modelSelectable}
                title={modelSelectable ? "Model" : "This agent uses its own default model"}
              >
                <span className="pill-glyph"><ModelGlyph /></span>
                <span className="pill-label">{modelLabel}</span>
              </button>
            </div>

            {/* Voice input sits just left of Send — tap to dictate (server
                transcription when a key is set, on-device Web Speech otherwise). */}
            <button
              type="button"
              className="composer-btn mic"
              onClick={startRecording}
              disabled={disabled}
              title="Voice input"
              aria-label="Voice input"
            >
              <MicGlyph />
            </button>

            {/* While busy with something typed AND the active runtime has
                advertised real steer support, offer an explicit way to inject
                it into the running turn right now — bypassing the queue
                entirely — alongside the default Send, which queues it (see
                AppController.sendPrompt/mustQueue) rather than assuming an
                interrupt is safe for runtimes that never promised one. */}
            {working && canSend && canSteer && (
              <button
                type="button"
                className="composer-btn steer"
                onClick={() => {
                  // A stale click (the turn just ended, or the runtime lost
                  // steer support) reports back rather than silently sending
                  // — only clear the draft once it actually went out.
                  if (controller.steerNow(text, attachments.length ? attachments : undefined)) clearComposer();
                }}
                title="Steer current turn — inject this now instead of queueing it"
                aria-label="Steer current turn"
              >
                ⚡
              </button>
            )}
            {/* Keep Stop available for an empty composer; once the user has
                entered a follow-up, the Send button takes its place. */}
            {working && !text.trim() && (
              <button type="button" className="composer-btn stop" onClick={onAbort} title="Stop" aria-label="Stop current turn">
                ■
              </button>
            )}
            {(!working || canSend) && (
              <button
                type="submit"
                className="composer-btn send"
                disabled={!canSend}
                title={working ? "Queue follow-up" : firstIsolatedRun ? "Launch Machine and send task" : "Send"}
                aria-label={firstIsolatedRun ? "Launch Machine and send task" : working ? "Queue follow-up" : "Send"}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </form>
      {picker === "repo" && <RepoPicker state={state} onClose={() => setPicker(null)} />}
      {picker === "sandbox" && <SandboxPicker state={state} onClose={() => setPicker(null)} />}
      {picker === "agent" && <AgentPicker state={state} onClose={() => setPicker(null)} />}
      {picker === "model" && modelSelectable && <ModelPicker state={state} onClose={() => setPicker(null)} />}
      {/* Portal to <body>. Like the pickers' Sheet, the viewer is
          `position: fixed` but rendered from deep inside the `.chat` scroll
          container. On iOS a fixed element does NOT escape a scrolling ancestor
          — it anchors to the scrolled content, and its stale compositor layer
          keeps swallowing taps on the composer after it closes, so the
          attachment thumbnails become unclickable ("can't reopen"). At <body>
          it is truly viewport-fixed and tears down cleanly. */}
      {viewing && createPortal(
        <div className="image-viewer" role="dialog" aria-modal="true" onClick={() => setViewing(null)}>
          <img className="image-viewer-img" src={viewing} alt="Attachment preview" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="image-viewer-close" onClick={() => setViewing(null)} aria-label="Close preview">
            ×
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
