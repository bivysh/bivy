// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { useModalEscape } from "../modalStack.js";

// The in-composer recording bar (mirrors the dictation UI in the screenshot):
// a cancel ✕, a live waveform, an elapsed timer, and a confirm ✓ that stops the
// recording, sends it to the node for transcription, and hands back the text.
//
// Recording starts on mount — the parent renders this only while dictating, so
// there is no separate "press to start" step here.

const BAR_COUNT = 28;

// Prefer Opus-in-WebM where available (small, high quality); fall back through
// the formats Safari/iOS actually produce. Empty string → let MediaRecorder pick.
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  const supported = (globalThis as any).MediaRecorder?.isTypeSupported;
  if (typeof supported === "function") {
    for (const c of candidates) {
      try {
        if (supported(c)) return c;
      } catch {
        /* ignore */
      }
    }
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result || "");
      resolve(url.includes(",") ? url.split(",").pop() || "" : url);
    };
    r.onerror = () => reject(r.error || new Error("Could not read the recording."));
    r.readAsDataURL(blob);
  });
}

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VoiceRecorder({
  transcribe,
  onResult,
  onCancel,
  onError,
}: {
  transcribe: (audioBase64: string, mimeType: string) => Promise<string>;
  onResult: (text: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  // Escape backs out of the recording bar at any point.
  useModalEscape(() => cancel());

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  // "cancelled" short-circuits the async onstop handler so a ✕ mid-flush never
  // resolves into the composer.
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);

  function teardown() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
  }

  useEffect(() => {
    let disposed = false;
    const media = (navigator as any)?.mediaDevices;
    if (!media?.getUserMedia || typeof (globalThis as any).MediaRecorder === "undefined") {
      onError("Voice input isn't supported in this browser.");
      onCancel();
      return;
    }

    media
      .getUserMedia({ audio: true })
      .then((stream: MediaStream) => {
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const mimeType = pickMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          teardown();
          if (cancelledRef.current) return;
          const type = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });
          void finish(blob, type);
        };
        recorder.start();
        startedAtRef.current = Date.now();
        startMeter(stream);
      })
      .catch(() => {
        onError("Microphone access was denied.");
        onCancel();
      });

    return () => {
      disposed = true;
      cancelledRef.current = true;
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer (once a second is enough — the waveform carries the motion).
  useEffect(() => {
    const id = setInterval(() => {
      if (startedAtRef.current) setElapsed(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, []);

  function startMeter(stream: MediaStream) {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < BAR_COUNT; i++) {
          const el = barsRef.current[i];
          if (!el) continue;
          // Spread the bins across the bar row; scale to a 12%–100% height so
          // silence still shows a resting sliver rather than collapsing.
          const v = (data[Math.floor((i / BAR_COUNT) * data.length)] ?? 0) / 255;
          el.style.transform = `scaleY(${Math.max(0.12, v)})`;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      /* waveform is decorative — ignore audio-graph failures */
    }
  }

  async function finish(blob: Blob, type: string) {
    setBusy(true);
    try {
      if (!blob.size) throw new Error("Nothing was recorded.");
      const base64 = await blobToBase64(blob);
      const text = await transcribe(base64, type);
      if (cancelledRef.current) return;
      if (text) onResult(text);
      else onError("No speech was detected.");
      onCancel();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onCancel();
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (busy) return;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop(); // fires onstop → finish()
      } catch {
        onCancel();
      }
    } else {
      // The mic hasn't finished initializing (the getUserMedia permission
      // prompt is still up, or was denied). There's nothing to stop and no
      // recorder to ever fire onstop, so spinning `busy` here would wedge the
      // bar forever with cancel unavailable. Just back out — the user can tap
      // the mic again once permission is granted.
      cancel();
    }
  }

  function cancel() {
    cancelledRef.current = true;
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    teardown();
    onCancel();
  }

  return (
    <div className="voice-bar" role="group" aria-label="Voice recording">
      {/* Stays enabled while transcribing: a hung/slow transcription must never
          leave the user trapped on a spinner with no way out (cancel short-
          circuits the in-flight result via cancelledRef). */}
      <button type="button" className="voice-btn cancel" onClick={cancel} aria-label="Cancel recording">
        ✕
      </button>
      <div className="voice-wave" aria-hidden>
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span
            key={i}
            className="voice-bar-tick"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      <span className="voice-time">{busy ? "…" : fmtElapsed(elapsed)}</span>
      <button type="button" className="voice-btn confirm" onClick={confirm} disabled={busy} aria-label="Use recording">
        {busy ? <span className="voice-spinner" /> : "✓"}
      </button>
    </div>
  );
}
