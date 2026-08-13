// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Text-to-speech for the agent's final replies, using the browser's built-in
// SpeechSynthesis API — no provider key and no backend, mirroring the on-device
// WebSpeechRecorder used for voice input. The reply text is markdown, so we
// reduce the syntax to plain prose before speaking so the voice reads the words
// a person would, not the punctuation.

export function speechSynthesisSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * Strip markdown down to speakable prose: drop code fences (reading code aloud is
 * noise), unwrap inline code, collapse links/images to their text, and remove
 * heading/emphasis/list/quote markers. Whitespace is normalized so the utterance
 * doesn't stutter on blank lines.
 */
export function markdownToSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "") // list bullets/numbers
    .replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*?$/gm, "") // horizontal rules
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$2") // strikethrough
    .replace(/\|/g, " ") // table pipes
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
