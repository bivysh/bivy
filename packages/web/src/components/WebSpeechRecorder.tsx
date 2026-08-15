// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { StatusDot } from "./StatusDot.js";

// On-device dictation fallback (the browser's Web Speech API) used when no Groq
// or OpenAI key is configured — voice input then works with no key and no cost,
// at the price of the browser's own accuracy and spotty support (notably weaker
// on iOS). When a key exists we use VoiceRecorder → server transcription instead.

export function webSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
  );
}

export function WebSpeechRecorder({
  onResult,
  onCancel,
  onError,
}: {
  onResult: (text: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [display, setDisplay] = useState("");
  const recRef = useRef<any>(null);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const doneRef = useRef(false);

  // Single exit path: stop the recogniser, and (when accepting) deliver the best
  // text we have from the refs so no result is lost to a stale closure.
  const settle = (accept: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    try {
      if (accept) recRef.current?.stop();
      else recRef.current?.abort();
    } catch {
      /* ignore */
    }
    if (accept) {
      const out = `${finalRef.current} ${interimRef.current}`.trim();
      if (out) onResult(out);
      else onError("No speech was detected.");
    }
    onCancel();
  };

  useEffect(() => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) {
      onError("Voice input isn't supported in this browser.");
      onCancel();
      return;
    }
    const rec = new Ctor();
    recRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    try {
      rec.lang = navigator.language || "en-US";
    } catch {
      /* default locale */
    }
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      interimRef.current = interim;
      setDisplay(`${finalRef.current} ${interim}`.trim());
    };
    rec.onerror = (e: any) => {
      const err = e?.error;
      if (err === "no-speech" || err === "aborted") return;
      onError(err === "not-allowed" || err === "service-not-allowed" ? "Microphone access was denied." : "Dictation error.");
      settle(false);
    };
    // Fires on stop() and on the engine's own silence timeout — either way, take
    // what we have.
    rec.onend = () => settle(true);
    try {
      rec.start();
    } catch {
      onError("Could not start dictation.");
      onCancel();
    }
    return () => {
      doneRef.current = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="voice-bar" role="group" aria-label="Voice dictation">
      <button type="button" className="voice-btn cancel" onClick={() => settle(false)} aria-label="Cancel dictation">
        ✕
      </button>
      <div className="voice-listening">
        <StatusDot status="working" />
        <span className="voice-listening-text">{display || "Listening…"}</span>
      </div>
      <button
        type="button"
        className="voice-btn confirm"
        onClick={() => {
          try {
            recRef.current?.stop();
          } catch {
            settle(true);
          }
        }}
        aria-label="Use dictation"
      >
        ✓
      </button>
    </div>
  );
}
