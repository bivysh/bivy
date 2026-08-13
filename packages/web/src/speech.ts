// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Read-aloud helpers. Browser synthesis remains the free/on-device option;
// OpenAI speech is requested through the node by the chat component.

export type SpeechReader = "browser" | "openai";
export type SpeechTone = "natural" | "calm" | "warm" | "energetic" | "professional";
export interface SpeechPreferences {
  reader: SpeechReader;
  browserVoice: string;
  rate: number;
  openaiVoice: string;
  tone: SpeechTone;
}

const STORAGE_KEY = "bivy.speech.preferences.v1";
const DEFAULTS: SpeechPreferences = {
  reader: "browser",
  browserVoice: "",
  rate: 1,
  openaiVoice: "coral",
  tone: "natural",
};

export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
export const SPEECH_TONES: Array<{ id: SpeechTone; label: string; instructions: string }> = [
  { id: "natural", label: "Natural", instructions: "Speak naturally and conversationally, with clear phrasing and subtle expression." },
  { id: "calm", label: "Calm", instructions: "Speak calmly and evenly at a relaxed pace, with a reassuring tone." },
  { id: "warm", label: "Warm", instructions: "Speak with a warm, friendly, empathetic tone." },
  { id: "energetic", label: "Energetic", instructions: "Speak with upbeat energy and engaging emphasis, without sounding exaggerated." },
  { id: "professional", label: "Professional", instructions: "Speak clearly and confidently in a polished, professional tone." },
];

export function getSpeechPreferences(): SpeechPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Partial<SpeechPreferences>;
    return {
      reader: value.reader === "openai" ? "openai" : "browser",
      browserVoice: typeof value.browserVoice === "string" ? value.browserVoice : "",
      rate: typeof value.rate === "number" && value.rate >= 0.7 && value.rate <= 1.5 ? value.rate : 1,
      openaiVoice: (OPENAI_VOICES as readonly string[]).includes(value.openaiVoice || "") ? value.openaiVoice! : DEFAULTS.openaiVoice,
      tone: SPEECH_TONES.some((tone) => tone.id === value.tone) ? value.tone! : DEFAULTS.tone,
    };
  } catch { return { ...DEFAULTS }; }
}

export function setSpeechPreferences(value: SpeechPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function speechToneInstructions(tone: SpeechTone): string {
  return SPEECH_TONES.find((item) => item.id === tone)?.instructions ?? "Speak naturally and conversationally.";
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function readAloudSupported(): boolean {
  return typeof window !== "undefined" && (speechSynthesisSupported() || typeof Audio !== "undefined");
}

/** Strip markdown down to speakable prose rather than reading its punctuation. */
export function markdownToSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$2")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
