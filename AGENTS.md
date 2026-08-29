# Agent guidance

Guidance for any agent working in this repo (this file is `AGENTS.md`; `CLAUDE.md`
is a symlink to it, so both names serve the same single source). Bivy runs coding agents on
machines you own — an open-source, self-hostable agent workspace. The node daemon
and CLI live in `src/`; shared logic in `packages/core`; the React PWA in
`packages/web`; the design system in `packages/ui`.

## Code structure philosophy

Build simple, standalone components that compose. Each piece should do one thing
and stand on its own, so capability comes from combining small parts — not from
one large, entangled unit.

- **Simple, not complex.** Keep things flat and readable — unbraided, not woven
  together. If a change forces you to hold several concerns in your head at once,
  that's the signal to split them apart.
- **Data over code.** Express variation as data — tables, config, declarative
  descriptions — rather than branching logic. Adding a case should mean adding a
  row, not another `if`.
- **Generalize the agent wrapper.** When working on the agent "wrapper" layer,
  always reach for the most general solution. The goal is to support *any* agent
  out of the box, with little-to-no custom adaptation — so avoid a bespoke
  adapter per agent. A per-agent special case is a last resort, not the default.

## Design system — follow it, don't fork it

All user-facing surfaces share one visual language. When you build or change any
UI, CSS, or component:

- **`packages/ui/tokens.css` is the single source of truth** for every color,
  spacing, radius, type, elevation and motion value. Use `var(--…)`; never
  hardcode a hex or a raw size. Change values there, not in app CSS.
- **Reuse existing components** in `packages/web/src/styles.css` instead of
  inventing near-duplicates. One badge/status/button system — no duplicate chips,
  no redundant badges, no new color for a state that already has a token. The
  styleguide shows the canonical set and what each consolidates.
- **Check the styleguide first:** `packages/ui/styleguide.html` (open in a
  browser) is the visual contract — light + dark.
- Full rules for the PWA: **[`packages/web/AGENTS.md`](packages/web/AGENTS.md)**.
- Run **`pnpm run check:design`** before finishing UI work — it fails if a
  palette token is redeclared outside `tokens.css` and flags raw-color drift.

## UI implementation workflow

Good UI is not done when the TypeScript compiles. For any user-facing change:

1. Read `packages/web/AGENTS.md`, inspect nearby screens/components, and check
   `packages/ui/styleguide.html` before writing new markup or CSS.
2. Reuse the existing component and token vocabulary. Do not create a second
   button, card, badge, status, modal, or spacing/color system for a similar job.
3. Design the complete state set, not only the happy path: loading, empty,
   error, disabled, success, long text, narrow/mobile layout, and keyboard
   interaction where applicable.
4. Render the real app and inspect it at desktop and mobile widths in both
   light and dark themes. Use the available browser/screenshot tooling when
   possible; do not rely only on reading the source.
5. Make at least one visual refinement pass based on the rendered result,
   checking hierarchy, alignment, spacing, density, contrast, overflow, and
   touch targets. Treat screenshots as test evidence, not decoration.
6. Verify keyboard focus and accessible names; information conveyed by color
   or shape must also have a textual or semantic equivalent.

Before finishing UI work, run `pnpm run check:design` and
`pnpm --filter @bivy/web run typecheck` (plus relevant tests). Report any
visual or test limitation instead of claiming the UI was verified when it was
not.

## Useful checks

- `pnpm run check:design` — design-token single-source-of-truth guard
- `pnpm run check:boundaries` — module architecture boundaries
- `pnpm run check:routes` — duplicate Express method/path guard
- `pnpm --filter @bivy/web run typecheck` — web PWA types
- `pnpm run lint` / `pnpm run typecheck`
