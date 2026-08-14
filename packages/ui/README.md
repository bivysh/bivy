# @bivy/ui — Bivy design system

The shared visual language for every Bivy surface: the canonical design tokens, a
styleguide, and shared component styles. This package is the **single source of
truth** — the web PWA consumes it directly, so there is exactly one place any
color/size value lives.

## What's here

- **`tokens.css`** — the single source of truth: semantic color (paper light +
  alpine-slate dark), a type scale, a 4px spacing rhythm, radius, elevation,
  motion, and z-index, as framework-agnostic CSS custom properties. Toggle dark
  mode with `<html data-theme="dark">`; it otherwise follows the OS, and respects
  `prefers-reduced-motion`. A compat-alias block at the end maps the older
  `--text` / `--border` / `--success` vocabulary onto the palette; prefer the
  canonical `--ink` / `--line` / `--ok` names in new code.
- **`styleguide.html`** — the visual contract: the canonical, de-duplicated
  component set (buttons, badges, status dots, cards, toasts, menus, tabs, …)
  rendered in both themes, each annotated with the app classes it consolidates.
  Open in a browser (no build step) — the tokens are inlined so it's fully
  self-contained; keep the inlined copy in sync with `tokens.css`. It is derived
  from the shipping PWA and is the target that `packages/web` converges toward.

## How it's consumed

The web PWA (`packages/web`) imports the tokens directly:

```ts
// packages/web/src/main.tsx
import "@bivy/ui/tokens.css"; // canonical palette, imported before styles.css
import "./styles.css";        // app styles — reference var(--…), never redeclare tokens
```

Resolution is wired via the `@bivy/ui` alias in `packages/web/vite.config.ts` and
the matching `paths` entry in `packages/web/tsconfig.json`. Because the tokens are
framework-agnostic custom properties, any future surface can consume them the same
way.

**The rule:** app CSS references tokens with `var(--…)` and never redeclares a
palette value. `pnpm run check:design` (run in CI) fails if a stylesheet outside
`tokens.css` declares a palette token, and flags raw-color drift.

See [`packages/web/CLAUDE.md`](../web/CLAUDE.md) for the design rules everyone —
including agents — follows.

### Icons

Icons are **Heroicons** (v2 outline, MIT) — not hand-rolled. To add one, copy the
`<path>` from the matching `node_modules/heroicons/24/outline/*.svg` into a new
`<symbol>`; stroke/fill come from the `.icon` CSS rule.
