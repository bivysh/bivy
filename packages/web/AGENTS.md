# packages/web — design rules

The Bivy web PWA. **Read this before touching any UI, CSS, or component.** These
rules exist so every surface — including work done by agents — stays one coherent
design system: clean, consistent, no duplicate badges/chips/status, no drift.

## 1. Tokens are the only source of truth

All color, spacing, radius, type, elevation, motion and z-index live in
**`packages/ui/tokens.css`** (imported before `styles.css` in `main.tsx`).

- **Never hardcode a color or size.** Use `var(--…)`. No new `#hex`, no raw `px`
  for spacing/radius where a token exists.
- To change or add a value, edit `tokens.css` — and mirror it into
  `packages/ui/styleguide.html`. Nowhere else may declare a palette token;
  `pnpm run check:design` fails if it does.
- Everything themes automatically (light/paper + dark/slate) **because** it goes
  through a token. Hardcoding a color breaks dark mode.

Canonical vocabulary (prefer these names):
`--bg`, `--surface` / `--surface-2` / `--surface-3`, `--ink`, `--muted`,
`--line` / `--line-strong`, `--accent` / `--accent-contrast` / `--accent-hover`,
`--ok`, `--danger` / `--danger-soft`, `--merged`, `--unseen`, the per-source
hues `--s-github` / `--s-slack` / … (see `sessionSource.ts`), `--radius`,
`--font-serif`. Type/spacing scales: `--text-*` / `--lh-*`, `--space-1…8`,
`--radius-sm…xl`, `--shadow-sm…xl`. (Older `--text` / `--border` / `--success`
names still resolve via a compat-alias block in `tokens.css`, but don't reach for
them in new code.)

## 2. Reuse components — don't reinvent them

Before you add a class, **search `styles.css` for one that already exists**, and
check the styleguide (`packages/ui/styleguide.html`, open in a browser) — it
shows the canonical, de-duplicated component set and names the classes each one
consolidates. Building a second button, badge, card, or menu that looks 90% like
an existing one is the #1 way this codebase gets messy.

- **One badge/pill/status system.** A status is shown once, one way. Don't add a
  parallel chip next to an existing one, and don't invent a new color for a state
  that already has a token (`--ok`, `--danger`, `--unseen`, `--merged`).
- **Status → color/shape is canonical**, defined in `sessionStatus.ts` (dot
  style) and `sessionSource.ts` (source hue). Render status through those, not by
  eyeballing a color.
- Don't duplicate information: if a label already conveys a state, don't add a
  redundant badge that repeats it.

## 3. Accessibility is part of "done"

- Keyboard focus must be visible (`:focus-visible`); the baseline outline in
  `styles.css` covers most controls — don't remove it.
- Any signal carried by color/shape alone needs an `.sr-only` text equivalent.
- Text on `--accent` uses `--accent-contrast` (meets WCAG AA in both themes).

## 4. Before you finish

- `pnpm run check:design` — single-source-of-truth + raw-color drift check.
- `pnpm --filter @bivy/web run typecheck`
- Verify the change in **both** light and dark (toggle in Settings, or
  `<html data-theme="dark">`).
