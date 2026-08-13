// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// High-quality read-aloud using OpenAI's speech endpoint. This is deliberately
// separate from Whisper/STT: it reuses the same OpenAI credential, but calls a
// text-to-speech model and returns audio rather than a transcript.

import { resolveSttKey } from "./stt.js";

export const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const OPENAI_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
export type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

const MAX_TTS_CHARS = 12_000;

export function isOpenAiTtsVoice(value: unknown): value is OpenAiTtsVoice {
  return typeof value === "string" && (OPENAI_TTS_VOICES as readonly string[]).includes(value);
}

export async function synthesizeOpenAiSpeech(input: {
  appDir: string;
  text: string;
  voice?: unknown;
  instructions?: unknown;
}): Promise<Buffer> {
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("There is no text to read aloud.");
  if (text.length > MAX_TTS_CHARS) throw new Error("This reply is too long to read aloud in one request.");

  const key = await resolveSttKey(input.appDir, "openai");
  if (!key) throw new Error("No OpenAI API key is available. Add one under Settings → Keys & OAuth.");

  const voice = isOpenAiTtsVoice(input.voice) ? input.voice : "coral";
  const instructions = typeof input.instructions === "string" ? input.instructions.trim().slice(0, 500) : "";
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice,
        input: text,
        response_format: "mp3",
        ...(instructions ? { instructions } : {}),
      }),
    });
  } catch (error) {
    throw new Error(`Could not reach OpenAI speech: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw.slice(0, 300);
    try { detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message || detail; } catch { /* raw response */ }
    throw new Error(`OpenAI speech failed (${response.status}): ${detail}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
