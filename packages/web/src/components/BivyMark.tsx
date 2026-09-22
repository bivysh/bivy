// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** The alpine ridge + spark from public/icon.svg, using the active app theme.
 * Decorative: pair with a visible Bivy heading or accessible label. Inline SVG
 * also keeps the mark available in bundled/offline clients without an asset URL.
 */
export function BivyMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path d="M23.5 4 L24.45 7.05 L27.5 8 L24.45 8.95 L23.5 12 L22.55 8.95 L19.5 8 L22.55 7.05 Z" fill="var(--accent)" />
      <path d="M28 11.4 L28.35 12.55 L29.5 12.9 L28.35 13.25 L28 14.4 L27.65 13.25 L26.5 12.9 L27.65 12.55 Z" fill="var(--accent)" opacity=".8" />
      <path d="M3 25.5 L11.5 11 L16.5 19.5 L20 14 L29 25.5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M3 25.5 H29" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".35" />
    </svg>
  );
}
