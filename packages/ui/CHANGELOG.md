# Styleguide iterations

The styleguide is developed in passes — each one reviewed, then improved.

## Iteration 11 — Green accent trials
- Added green-focused accent studies to the live styleguide picker: British racing,
  racing, forest, pine, moss, and sage.
- Added matching `data-accent` presets so the same green directions can be tested
  outside the picker.

## Iteration 10 — Themeable accent + live picker
- Refactored accent tokens so the whole brand color flows from a single
  `--accent`: `--accent-hover/-active/-soft` and `--focus-ring` now derive via
  `color-mix()` (and adapt to light/dark automatically).
- Added **accent presets** (`data-accent`): indigo, violet, emerald, teal, cyan,
  amber, orange, rose, graphite — plus the blue default.
- Styleguide gets a live **accent picker** (top of page) that recolors the entire
  UI, including the mobile mocks, in light and dark.

## Iteration 9 — Mobile density (four passes)
Feedback: everything on mobile was too big for the real estate. Four `.phone`-
scoped passes (desktop untouched):
1. **Global scale** — 13px base, smaller nav title/subtitle/icon buttons, 8px
   thread padding & gap, 22px avatars, 11px meta.
2. **Fuller-width messages** — assistant replies span full width with no bubble;
   user stays a compact right-aligned bubble; 13/19 text.
3. **Compact cards** — denser inline approval (removed oversized inline styles),
   tool-call card, session rows, and badges.
4. **Slim composer & chrome** — 36px composer field/buttons, 28px inline mic,
   tighter tab bar, and a more compact bottom sheet.

## Iteration 8 — Mobile app UX + desktop shell fix
- **Fix:** the desktop shell's composer and connection footer were clipped — the
  scroll areas lacked `min-height:0`, so they overflowed the fixed-height card.
  Added `min-height:0` to the shell's grid items and flex scroll children.
- **Mobile app (the big one):** replaced the single approval bottom-sheet mock
  with a full mobile experience that mirrors the desktop — you can *talk to the
  agent on the phone like on the computer*, not just approve/deny:
  - **Chat screen:** top bar (back, title, connection + model, overflow), a
    scrolling thread (messages with avatars, live tool call, inline approval,
    streaming indicator), and a real **composer** (attach, text input, voice mic,
    send) pinned above the safe area.
  - **Sessions screen:** node header, session list with status, and a bottom tab
    bar (Chats / Activity / Settings).
  - **Approval** kept as a push → bottom sheet for the destructive case.
  - Touch-first: 44px targets, `env(safe-area-inset-bottom)`, correct
    `min-height:0` scrolling so nothing clips. Added 9 Heroicons (back, mic,
    send, plus, more, chat, clock, cog, stop).
  - **Layout redo (after device review):** the composer input was being starved
    by four round buttons (placeholder truncated to "Message th"), and the inline
    approval crowded/clipped against the composer. Fixes: roomier phone
    (320×640), the **mic now lives inside a pill input field** (attach · field ·
    send), a **compact inline approval** (Approve/Reject/Preview on one row), and
    a trimmed thread so the whole exchange fits without clipping.

## Iteration 1 — Foundations
Review found: no icon system (emoji/✦), type scale never shown, single-note
buttons, density a touch soft. Changes:
- Added an inline SVG **icon system** (currentColor, feather-style) + icon grid.
- Added a **typography specimen** rendering the full scale.
- Real **button system**: sizes (md/sm), icon buttons, disabled + loading states.
- Sticky blurred header; crisper density; two-column layout for related specs;
  section notes explaining intent.

## Iteration 2 — Component depth
- Approval card now shows the **severity range** (low→critical) with a severity
  legend, a destructive/permanent example with a **"what changes" diff preview**,
  and reusable **"always allow" scopes** (chip toggles).
- Added **command palette / model picker**, **inline alerts** (info/warn/danger),
  a **settings** block (segmented control + switches), an **empty state**, and
  **kbd** shortcut styling. Controls are interactive in the page.

## Iteration 7 — Wayfinding + foundations
- Auto-generated **"on this page" nav** (built from section headings) with smooth
  anchored scrolling and `scroll-margin` so jumps clear the sticky header.
- New **Foundations** section visualizing the radii, elevation, and 4px spacing
  scales; expanded the color section to include text/border/soft tokens.

## Iteration 6 — Richer core components
- **Messages** now have avatars, a sender + timestamp meta row, and an animated
  **streaming "thinking" indicator** — the chat surface reads finished.
- **Tool-call card** feels live: status badge (Done/Running with spinner),
  duration, and a collapse chevron; shows a running example too.
- Added **tabs**, **tooltip**, and **avatar** primitives (interactive tabs).

## Iteration 5 — Systematize + native feel
- New **`.status-dot` utility** replaces hand-styled inline dots in 8 places
  (design-system hygiene; no more drift).
- **Custom slim scrollbars** + `::selection` color + `accent-color` for native
  form controls — removes the default-chrome "tell."
- **Button hover lift** (translateY -1px) for a more tactile feel.

## Iteration 4 — Real icon library (Heroicons) + render fix
- **Bug fix:** icons were invisible (notably in buttons/alerts). The sprite put
  `stroke` on a `<g>` wrapper, but `<use href="#symbol">` clones the symbol's
  subtree and ignores that parent, so nothing painted. Stroke/fill are now set on
  the `.icon` rule itself, which the `<use>` instances inherit.
- **Switched to Heroicons** (v2 outline, MIT) instead of hand-drawn icons. Added
  `heroicons` as a devDependency; the sprite's path data is copied verbatim from
  `node_modules/heroicons/24/outline/*.svg`. (Phase 1 / React should consume
  `@heroicons/react` directly rather than the sprite.)

## Iteration 3 — Composition & polish
- Added a composed **desktop app-shell mock** (sidebar + session list +
  connection foot + chat thread with tool call and a docked approval +
  composer) so the system reads as a product, placed first on the page.
- Added a **mobile bottom-sheet approval** (push → sheet) with large touch
  targets, using the critical/destructive example.
- Responsive: the shell collapses to a single column under 760px. A11y:
  `role="dialog"` on approval surfaces, `role="status"`/`aria-live` on toasts,
  reduced-motion respected throughout.
