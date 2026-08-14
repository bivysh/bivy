// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// ANSI escape-sequence stripping for user-facing CLI output.
//
// Dumb-pipe CLI agents (OpenCode, Aider, …) colorize their stdout/stderr with
// ANSI SGR/CSI escapes meant for a real terminal. Bivy relays that text into the
// app's "Agent output" pane verbatim, where the escapes render as garbage like
// `[91m[1mError: [0m…` instead of a red bold "Error:". The pane shows plain
// text, so the color codes carry no information — strip them at display time.
//
// We strip only what's emitted to the UI, never the buffered stdout/stderr the
// runtime parses for exit-code/error logic, so parsing stays byte-exact.

// ESC () or 8-bit CSI () introducer followed by either:
//   • an OSC string (`ESC ] … BEL` — window title / hyperlinks), or
//   • a CSI sequence (`ESC [ params final-byte` — colors, cursor moves).
// The final-byte class is deliberately broad so SGR colors (incl. 24-bit),
// cursor moves, and erase codes are all removed. Mirrors the widely-used
// `ansi-regex` pattern, restated with explicit escapes (no literal control
// characters in source).
const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|"),
  "g",
);

/** Remove ANSI escape sequences from a string for plain-text display. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}
