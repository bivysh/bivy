# Bivy web PWA — migration status

`@bivy/web` (React + Vite + vite-plugin-pwa over `@bivy/core`) is the **single
client** that replaces the two hand-synced vanilla copies:

- `services/control-plane/public/` + `remote-app.js` — served at **app.bivy.sh** (the product)
- root `public/` + `remote-app.js` — served by the **local node** daemon

These two had **drifted** (the last several PRs — #217, #219, #220 — only
updated the root copy, so they never reached app.bivy.sh). One React app served
on both surfaces, differing only in transport, removes that whole failure mode.

**One app, two transports (auto-selected):**

- **RelayTransport** — E2E via the relay, for the hosted control plane (app.bivy.sh).
- **DirectTransport** — same-origin `/ws`, for a local node (`?local=1` / loopback).

**Served at `/next`** during the migration (`/app` is the legacy module dir on
both surfaces). End state: serve at the root once the legacy client is removed.

## Done

- npm workspaces monorepo; `@bivy/core` typed + unit-tested (**20 tests**),
  including the X25519 pairing round-trip.
- Vite + React + vite-plugin-pwa; correct prompt-to-update SW lifecycle; no
  inline scripts (CSP-safe).
- `SessionStore` reducer → React via `useSyncExternalStore` (UI = f(state)).
- Screens: shell + responsive drawer, status pill, session list + search, chat
  (markdown, streaming assistant/thinking, tool cards), composer, approvals,
  theme, update toast, hosted setup/sign-in notice.
- **Served on both surfaces**: node daemon at `/next` (src/server.ts); control
  plane at `/next` (services/control-plane/src/index.ts + Docker build stage).

## Needs live validation

RelayTransport is ported faithfully and unit-tested at the crypto layer, but the
full handshake needs a real control-plane + relay + paired node + signed-in
account to confirm end-to-end. DirectTransport is verified against a live node
(reaches `online`, streams, sends prompts).

## Reached parity

| Area | Notes |
| --- | --- |
| Performance | Per-session transcript cache (instant switch), memoized entries, grouped tool activity, chat windowing, and a memoized markdown renderer so long sessions stay smooth. |
| Tool activity + markdown | Grouped activity line + expandable File/Command/Query/Diff/Output detail with a real LCS diff viewer (`@bivy/core` `tool-format`, unit-tested); richer assistant markdown (headings, blockquotes, task lists, hr). |
| Composer pickers | GitHub repo (new session), agent/runtime picker (+ install), model picker with reasoning-level pill; draft-vs-live selection threaded into `session.new`; remembered via `LocalStore.lastChoice`. |
| Terminal overlay | xterm.js PTY attach — fresh shell, per-scope reattach, run-terminal + tmux/zellij/screen multiplexer attach. |
| Settings panels | Keys & OAuth (API key + OAuth sign-in), remembered decisions, GitHub issue setup, account/billing/usage, push notifications, device linking. |
| Ephemeral provisioning | Fly/Hetzner bring-your-own-token flow ported into `@bivy/core` (`ephemeral.ts`); launch/destroy from the node selector. |
| Sticky sidebar | Shell pinned to the viewport so a long chat scrolls the chat pane, not the page. |

## Recently landed (parity gaps closed)

| Area | Notes |
| --- | --- |
| Pairing-rejection recovery + reason | The relay client used to stall in "linking…" forever after a `pairing rejected` (socket left half-open, `pairSent` stuck true). Now the node/control-plane relay the **concrete reason** (e.g. "Device limit reached (2)") through `pair.error`: permanent reasons (device cap, wrong account, unauthorized) surface immediately and stop; transient ones re-mint a fresh single-use grant and retry with backoff before giving up. This was the real cause behind "linking works in the legacy client but not `/next`" — a signed-in `/next` on a fresh origin presents a *new* device key and trips the account device cap, which previously showed only a bare, endlessly-retrying "pairing rejected". Covered by `RelayTransport` unit tests (fake WebSocket + fetch) — **43 core tests**. |
| Header UX | Top bar no longer crushes the title on mobile: a `.topbar-title` block gives the title room plus a quiet agent · model subtitle, actions are grouped, and the status pill collapses to a colour dot on narrow screens (the reconnect banner carries the words). |
| Composer UX | Meta pills (attach / repo / agent / model) share one horizontally-scrolling row so the send control stays pinned no matter how long the names get; softer card, clearer focus ring, tactile send/stop. |
| Edge-swipe drawer | Left-edge swipe opens the session drawer and swipe-left closes it, matching the native gesture (`useEdgeSwipe`, horizontal-dominant so it never fights vertical scroll). |
| Streaming pipeline fix | The node wraps every turn event in a `session.event` envelope; the reducer now unwraps it (with the legacy focus guard), so streamed assistant/tool messages render. This was the root cause of "no messages from the agent". |
| Session lifecycle (P0.1) | Per-row rename / delete / open-PR menu; composer pause/resume driven from `pausedSessionIds`; `session.pr_result` folded into github context. |
| Composer attachments (P0.2) | Paperclip + file input, removable chips, base64 image / text-file reading matching the node's `attachmentsFrom` shape. |
| Usage / cost (P0.3) | `session.usage` + history `usage` folded into state; dismissable usage bar in chrome. |
| Email magic-link (P0.4) | SetupNotice posts to `/auth/magic-link/start` with a confirmation. |
| Draft sessions | "+ New" and agent-switch are pure local drafts — no session created on the node until the first prompt. |
| List status dots | Live idle/working/needs-action dot per row, folded from `session.event` + approvals. |
| User-echo dedup | `clientMessageId` threads through prompts so the node's `session.user_message` echo no longer double-renders the bubble. |
| Stranded PRs #217/#219/#220 | Reimplemented in React: approval-card persistence (`ApprovalCard` keeps a pending/"waiting for the node" state until `approval.resolved`), the context-aware GitHub session actions menu, and the GitHub status pill + action sheet (`GithubPill`). |
| Streaming reasoning (P1.2) | The reducer now folds incremental `thinking_delta` / `thinking_end` off `assistantMessageEvent` (not just accumulated `thinking` blocks), so runtimes that stream reasoning render it live token-by-token; the block stays authoritative when present. Covered by store unit tests. |
| History cursor / append mode (P1.1) | `@bivy/core` `createTranscriptCache` (IndexedDB, LRU, no-op fallback) persists decrypted transcripts per session so past chats paint before the node answers; the store keeps raw messages + the `count`/`historyHash` cursor and applies `mode:"append"` deltas onto the cached prefix, so reconnects backfill only the new tail; a mid-turn `session.history` is deferred and re-requested at `agent_end` (focus arbitration) so a stale snapshot never erases live output. Store + cache unit tests; IndexedDB round-trip verified headless in Chromium. |
| Per-message copy (P2) | Assistant replies get a hover-revealed "Copy" affordance (`ChatView`'s `CopyButton`) that copies the raw markdown, not the rendered HTML, so pasting elsewhere keeps code fences/lists intact; touch devices get a faint always-on baseline instead of relying on hover. `writeClipboard` (Clipboard API + `execCommand` fallback) moved out of `Terminal.tsx` into a shared `src/clipboard.ts` so both call sites use one implementation. |
| UI review fixes, batch 1 (#370) | First batch off a full UI/UX review (see the issue for the full findings + roadmap): fixed a WCAG-AA contrast failure on light-theme accent buttons (`--accent-contrast` was ~3.2:1, now ~5.4:1); fixed `PrToast`/`UpdatePrompt` rendering on top of each other when both are live (shared `.toast-stack`); fixed a real nested-`<button>`-inside-`<button>` bug in `Settings`/`Pickers`/`Ephemeral` action rows (`PickerItem`'s `right` slot is now a sibling, not a child, of the row button — the Revoke/Remove/Sign out/Install/Destroy actions were invalid HTML and unreachable by keyboard); added a baseline `:focus-visible` ring for every custom interactive element that didn't already draw one; added `prefers-reduced-motion` support (nothing respected it before); made the session-list status dot and node online/offline dot announce to screen readers instead of color/tooltip-only; fixed `UsageBar`'s dismiss button being a no-op (was keyed on a snapshot of live-updating usage, so it reappeared on the next tick — now a per-session dismiss); made the error boundary's "Try again" actually remount the recovered subtree instead of silently re-rendering the same broken instances. |
| UI review fixes, batch 2 (#370) | The rest of the review's follow-up list. `SetupNotice`'s GitHub device sign-in: a blocked/lost `window.open()` used to leave "Waiting for GitHub…" spinning forever with no escape — now always renders a real fallback link plus a Cancel button once the device code is known. `ApprovalCard`/`QuestionCard`: a resolution that never arrives (dropped message, node reconnect mid-flight) used to leave the card pending forever — both now surface "taking longer than expected" with a Retry after 8s. Composer: an unknown slash command no longer wipes the typed text; multi-file attach shows a "Reading files…" spinner instead of looking frozen; `.composer-btn`/`.attach-remove` tap targets bumped up. Settings: full "Sign out" now confirms like every other destructive action here; provider/STT key save-and-remove re-fetch the live list instead of a blind `setTimeout` that "looked" saved regardless of outcome (`ProvidersPanel`'s `managing` is now derived live from `state.providers`, not a frozen snapshot); the GitHub token field clears after submit. Session actions: `window.prompt`-based rename replaced with a real sheet (`RenameSheet`, shared by `SessionList` and `SessionMenu`); "Create pull request" now stays visibly busy through the round trip instead of the menu just closing; the header menu and row menu now expose the identical PR affordance (every PR as a direct link, "Create" only when none is open). Onboarding: `apple-touch-icon`/favicon switched from the maskable full-bleed `tent.png` to the plain `icon-192.png` (the maskable one was rendering padded/off-center); two media-scoped `theme-color` meta tags give the correct system-default browser-chrome color before any JS runs. The manifest's static native splash-screen color remains a known platform limitation (no such thing as a per-user-preference field in the Web App Manifest spec today) — documented in `vite.config.ts`. |

## Not yet at parity (tracked follow-ups)

| Area | Notes |
| --- | --- |
| Node-broker ephemeral exec | Only the cloud-relay `exec` transport is wired; the E2E node-broker (`ephemeral.exec` frame) is not yet. |

## Cutover

1. Reach parity behind `/next` on app.bivy.sh.
2. Flip `/` to serve the React app; keep legacy at `/legacy` for one release.
3. Delete both vanilla copies (`public/app/remote-app.js` ×2) + add a CI guard
   so future work can only land in `@bivy/web`.
4. Add `packages/mobile` (Expo Router) reusing `@bivy/core`.
