// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SttConfig } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { VoiceRecorder } from "./VoiceRecorder.js";
import { WebSpeechRecorder, webSpeechSupported } from "./WebSpeechRecorder.js";

export type DictationEngine = "server" | "webspeech";

/** How this device dictates: a stored provider key routes audio through the
 *  node (best quality, over the encrypted session channel); otherwise the
 *  browser's own dictation (no key, no cost). Null when neither is available.
 *  Before the node has said which keys exist, assume the node. */
export function dictationEngine(sttConfig: SttConfig | null | undefined): DictationEngine | null {
  if (!sttConfig || sttConfig.providers.some((p) => p.configured)) return "server";
  return webSpeechSupported() ? "webspeech" : null;
}
export const NO_DICTATION = "Add a Groq or OpenAI key in Settings → Voice input to use voice input.";

/** The recording bar for an engine. It starts listening when it mounts;
 *  bump `stop` to finish from outside (a released hold-to-talk). */
export function Dictation({ engine, stop, onResult, onCancel, onError }: {
  engine: DictationEngine; stop?: number;
  onResult: (text: string) => void; onCancel: () => void; onError: (message: string) => void;
}) {
  return engine === "server"
    ? <VoiceRecorder transcribe={(audio, mime) => controller.transcribe(audio, mime)} stop={stop} onResult={onResult} onCancel={onCancel} onError={onError} />
    : <WebSpeechRecorder stop={stop} onResult={onResult} onCancel={onCancel} onError={onError} />;
}
