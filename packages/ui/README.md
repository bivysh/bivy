# packages/ui — Bivy design system

The shared visual language for Bivy surfaces: framework-agnostic design tokens, a
styleguide, and dependency-free template helpers for static app surfaces.

## What's here

- **`tokens.css`** — the single source of truth: semantic color (light + dark),
  a type scale, a 4px spacing rhythm, radius, elevation, motion, and z-index, as
  framework-agnostic CSS custom properties. Toggle dark mode with
  `<html data-theme="dark">`; it otherwise follows the OS, and respects
  `prefers-reduced-motion`.
- **`components.css`** — reusable styleguide component classes for the static
  template layer (badges, buttons, message rows, tool cards, approval cards).
- **`styleguide.html`** — renders the tokens and a set of base-component specs
  (buttons, inputs, badges, session item, messages, tool-call card, toast,
  skeleton, connection badge, and the approval card with plain-language
  consequence translation) in both themes. Open it in a browser and use the
  "Toggle theme" button to check light/dark.
- **`templates.js`** — dependency-free template helpers for static app surfaces.
  It exposes `window.MeshUI`.

The tokens are framework-agnostic, so they can be consumed from any framework.
The React PWA client lives in [`packages/web`](../web).

### Icons

Icons are **Heroicons** (v2 outline, MIT) — not hand-rolled. The styleguide
embeds them as an inline SVG sprite whose path data is copied verbatim from the
`heroicons` npm package (`node_modules/heroicons/24/outline/*.svg`); stroke/fill
come from the `.icon` CSS rule. To add one, copy the `<path>` from the matching
Heroicons file into a new `<symbol>`.

## How to view

Open `packages/ui/styleguide.html` directly in a browser (no build step). The
design tokens are **inlined** in the file, so it is fully self-contained — handy
for reviewing on a phone with nothing else alongside it. `tokens.css` remains the
canonical source of truth; keep the inlined copy in sync when tokens change.
