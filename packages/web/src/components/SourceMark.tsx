// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// One monochrome glyph per run source, drawn in `currentColor` so the tile can
// tint it (see `.source-mark` in styles.css). Brand marks (GitHub, Slack,
// Linear) use their real logo geometry; the rest are line glyphs that match the
// app's other stroked icons (mic, attach, filter).

import type { SourceKind } from "../sessionSource.js";

/** The bare glyph, sized by its parent's font/box. */
export function SourceGlyph({ kind }: { kind: SourceKind }) {
  switch (kind) {
    case "github-issue":
    case "github-mention":
      return (
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      );
    case "slack":
      // Official Slack mark (Simple Icons geometry), flattened to one colour.
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.528 2.528 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
        </svg>
      );
    case "linear":
      // Official Linear mark (Simple Icons geometry).
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M.403 13.517c-.06-.213.19-.365.347-.207l9.94 9.94c.157.157.006.407-.207.347C5.24 22.293 1.707 18.76.403 13.517zM.004 10.62a.19.19 0 0 0 .056.148l13.117 13.117a.19.19 0 0 0 .148.056 11.9 11.9 0 0 0 1.951-.324.19.19 0 0 0 .09-.32L.648 8.58a.19.19 0 0 0-.32.089c-.157.636-.266 1.288-.324 1.95zM1.036 6.926a.19.19 0 0 0 .038.22l15.78 15.78a.19.19 0 0 0 .22.038 12 12 0 0 0 1.463-.842.19.19 0 0 0 .03-.297L2.175 5.433a.19.19 0 0 0-.297.03 12 12 0 0 0-.842 1.463zM2.658 4.5a.19.19 0 0 1-.02-.245C4.847 1.203 8.194 0 12 0 18.627 0 24 5.373 24 12c0 3.806-1.203 7.153-4.255 9.362a.19.19 0 0 1-.245-.02L2.658 4.5z" />
        </svg>
      );
    case "schedule":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "webhook":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="6.5" r="2.6" />
          <circle cx="18" cy="9.5" r="2.6" />
          <circle cx="9.5" cy="18" r="2.6" />
          <path d="M7.6 8.6 8.9 15.4M8.3 6.9 15.4 8.6M16.2 11.8 11.4 16.4" />
        </svg>
      );
    case "manual":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.5 3.7 18 11l-5 1.4 2.7 5.6-2.4 1.1-2.7-5.6L5.2 18z" />
        </svg>
      );
    case "cli":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 7l4 4-4 4M12 16h6" />
        </svg>
      );
    case "app":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 5.5h16v10.5H9l-4 3.5v-3.5H4z" />
        </svg>
      );
  }
}

/** The tinted tile that carries the glyph. `size` is the visual tier: `md` for
 *  the sidebar row, `sm` for the in-session pill / queue chip. */
export function SourceMark({ kind, size = "md", title }: { kind: SourceKind; size?: "md" | "sm"; title?: string }) {
  return (
    <span className={`source-mark ${size === "sm" ? "sm" : ""} src-${kind}`} title={title} aria-hidden>
      <SourceGlyph kind={kind} />
    </span>
  );
}
