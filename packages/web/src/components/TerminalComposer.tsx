// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { controller, useAppState } from "../store/useStore.js";
import { VoiceRecorder } from "./VoiceRecorder.js";
import { WebSpeechRecorder, webSpeechSupported } from "./WebSpeechRecorder.js";
import { MicGlyph } from "./Composer.js";
import { useModalEscape } from "../modalStack.js";

// Mirrors the chat composer's mobile breakpoint (styles.css `.only-mobile`). On a
// phone there's no keyboard modifier to distinguish "send" from "new line", so
// Enter inserts a newline and the on-screen Send button submits. Desktop keeps
// Enter = send / Shift+Enter = newline, plus Cmd/Ctrl+Enter as an always-send.
function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
}

/**
 * A batch "compose" surface for the terminal — a comfortable multi-line editor
 * with voice-to-text, for when composing a long command (or prose to an agent
 * running in the terminal) directly at the raw PTY prompt is awkward.
 *
 * It deliberately does NOT capture the shell's keystroke stream the way the grid
 * does: it composes a block of text and hands it to the PTY on demand, reusing
 * the same `sendInput` path as the snippet chips. **Insert** writes the text at
 * the prompt so you can review/edit it and press Enter yourself; **Send** writes
 * it followed by a carriage return, submitting it. Attachments are intentionally
 * out of scope — a byte-stream PTY has no place to put them.
 */
export function TerminalComposer({
  onInsert,
  onSend,
  onClose,
  onError,
}: {
  /** Write the text at the prompt without a trailing Enter (user submits). */
  onInsert: (text: string) => void;
  /** Write the text plus a carriage return (submits it). */
  onSend: (text: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const state = useAppState();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState<null | "server" | "webspeech">(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Escape closes the panel — but not while a recorder is up (it owns Escape to
  // cancel dictation), so gate the handler on `!recording`.
  useModalEscape(onClose, !recording);

  // Pull the voice-input config once so dictation can route through the node when
  // a key is stored (and we can point the user at Settings otherwise) — same
  // logic as the chat composer.
  useEffect(() => {
    if (!state.settings.sttConfig) controller.getSttConfig();
  }, [state.settings.sttConfig]);
  const voiceReady = Boolean(state.settings.sttConfig?.providers.some((p) => p.configured));

  // Layout effect (not passive) so that when the opener mounts us synchronously
  // via flushSync inside the tap, this focus() still runs *within* that gesture —
  // the only way iOS Safari will raise the keyboard on open rather than just
  // placing a caret.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      autosize();
    }
  }, []);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  // Pick the transcription engine: a stored provider key routes audio through the
  // node (best quality); otherwise fall back to on-device Web Speech (no key, no
  // cost). Only error when neither is available.
  function startRecording() {
    if (voiceReady || !state.settings.sttConfig) setRecording("server");
    else if (webSpeechSupported()) setRecording("webspeech");
    else onError("Add a Groq or OpenAI key in Settings → Voice input to use voice input.");
  }

  // Append a dictated transcript to the draft, then refocus the editor.
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

  const canSend = Boolean(text.trim());
  const doSend = () => {
    const value = text.trimEnd();
    if (!value) return;
    onSend(value);
    setText("");
    requestAnimationFrame(() => {
      autosize();
      taRef.current?.focus();
    });
  };
  const doInsert = () => {
    const value = text.trimEnd();
    if (!value) return;
    onInsert(value);
    setText("");
    requestAnimationFrame(autosize);
  };

  return (
    <div className="term-composer">
      {recording === "server" && (
        <VoiceRecorder
          transcribe={(audio, mime) => controller.transcribe(audio, mime)}
          onResult={insertTranscript}
          onCancel={() => setRecording(null)}
          onError={onError}
        />
      )}
      {recording === "webspeech" && (
        <WebSpeechRecorder onResult={insertTranscript} onCancel={() => setRecording(null)} onError={onError} />
      )}
      <textarea
        ref={taRef}
        className="composer-input term-composer-input"
        placeholder="Compose a command or message — Send runs it, Insert drops it at the prompt"
        rows={1}
        hidden={Boolean(recording)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          autosize();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              doSend();
              return;
            }
            if (e.shiftKey || isMobileViewport()) return; // newline
            e.preventDefault();
            doSend();
          }
        }}
      />
      <div className="term-composer-actions" hidden={Boolean(recording)}>
        <button type="button" className="composer-btn mic" onClick={startRecording} title="Voice input" aria-label="Voice input">
          <MicGlyph />
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={doInsert}
          disabled={!canSend}
          title="Insert at the prompt without running — press Enter in the terminal yourself"
        >
          Insert
        </button>
        <button
          type="button"
          className="composer-btn send"
          onClick={doSend}
          disabled={!canSend}
          title="Send to the terminal and press Enter"
          aria-label="Send to terminal"
        >
          ↑
        </button>
      </div>
    </div>
  );
}
