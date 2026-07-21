# packages/ui — Bivy design system

The shared visual language for every Bivy surface (local UI, remote client, the
future React component library, and the mobile token mirror). Created as **Phase
0** of [`docs/ui-polish-plan.md`](../../docs/ui-polish-plan.md) — the work to
reach Termius-level fit and finish.

## What's here now (Phase 0)

- **`tokens.css`** — the single source of truth: semantic color (light + dark),
  a type scale, a 4px spacing rhythm, radius, elevation, motion, and z-index, as
  framework-agnostic CSS custom properties. Toggle dark mode with
  `<html data-theme="dark">`; it otherwise follows the OS, and respects
  `prefers-reduced-motion`.
- **`components.css`** — reusable styleguide component classes for the static
  template layer (badges, buttons, message rows, tool cards, approval cards).
- **`styleguide.html`** — renders the tokens and a first set of base-component
  *specs* (buttons, inputs, badges, session item, messages, tool-call card,
  toast, skeleton, connection badge, and the **approval card** — the moat
  component with plain-language consequence translation) in both themes. Open it
  in a browser; use the "Toggle theme" button to check light/dark.
- **`templates.js`** — dependency-free template helpers for the static app
  surfaces. It exposes `window.MeshUI` and is copied into `public/bivy-ui.js`
  and `services/control-plane/public/bivy-ui.js` until Phase 1 introduces a
  proper React/component build.

These are intentionally framework-agnostic so they can feed whatever framework
Phase 1 chooses without rework.

### Icons
Icons are **Heroicons** (v2 outline, MIT) — not hand-rolled. The styleguide
embeds them as an inline SVG sprite whose path data is copied verbatim from the
`heroicons` npm package (`node_modules/heroicons/24/outline/*.svg`); stroke/fill
come from the `.icon` CSS rule. To add one, copy the `<path>` from the matching
Heroicons file into a new `<symbol>`. In Phase 1 (React), consume
`@heroicons/react` components directly instead of the sprite.

## How to view

Open `packages/ui/styleguide.html` directly in a browser (no build step). The
design tokens are **inlined** in the file, so it is fully self-contained — handy
for reviewing on a phone with nothing else alongside it. `tokens.css` remains the
canonical source of truth; keep the inlined copy in sync when tokens change.

## Next (per the plan)

- **Phase 1:** pick the framework (recommended React + Tailwind + headless
  primitives), turn these specs into real components in this package, build the
  adaptive app shell, and start consuming it from the surfaces — collapsing the
  two divergent clients (`public/index.html`, `services/control-plane/public/remote.html`)
  into one codebase.
- **Phase 3:** invest disproportionately in the approval card (the trust/moat
  component) — see the plan.
