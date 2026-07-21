# React PWA — remaining parity work (implementation plan)

Hand this to a fresh agent session. It continues the work in PR #223
(branch `claude/react-pwa-implementation-0a3krb`), which already brought the
React client (`packages/web`) to functional parity with the legacy vanilla
client for: performance, tool/markdown rendering, sticky sidebar, composer
repo/agent/model pickers, ephemeral machines, terminal, and settings panels.

This plan covers the **remaining gaps**. Do the P0 items for full functional
parity; P1/P2 are refinements.

---

## 0. Orientation (read first)

**Monorepo layout**
- `packages/core` — framework-agnostic TypeScript: protocol, transports, crypto,
  and the reactive `SessionStore`. No DOM, no React. Unit-tested with vitest.
- `packages/web` — React + Vite PWA over `@bivy/core`. This is the only client.
- Legacy reference (do NOT modify, read for behavior): `public/app/remote-app.js`
  + `public/remote.html` (the local-node copy carries the newest UX). Helper
  modules in `public/app/*.js`.

**Architecture (how a command/event flows)**
- UI intent → `AppController` (`packages/web/src/store/controller.ts`) → typed
  `Command` → `Transport.send`.
  - `DirectTransport` (`packages/core/src/transport-direct.ts`) maps each command
    to a REST call and re-emits the result as a synthetic event. **This switch is
    the authoritative command→endpoint spec.** In direct mode, add new commands
    here.
  - `RelayTransport` (`transport-relay.ts`) seals every command into an E2E frame;
    no per-command mapping needed — new commands work automatically over relay.
- Node event → `controller` `onEvent` → `SessionStore.apply(event)`
  (`packages/core/src/store.ts`) folds it into immutable `AppState`.
- React reads state via `useAppState()` (`useSyncExternalStore`). Components live
  in `packages/web/src/components`.
- Bottom-sheet UI: reuse `Sheet` + `PickerItem` from `components/Sheet.tsx`.

**Command/event shapes**: the table at the bottom of the legacy settings map is
mirrored by `DirectTransport.send`. When unsure of a payload, grep the node
handler in `src/server.ts` (e.g. `/api/session/prompt`, `/api/sessions/rename`).

**Verification (run before every commit)**
```
npm run -w @bivy/core build && npm run -w @bivy/core test
npm run -w @bivy/web typecheck && npm run -w @bivy/web build
npm run typecheck && npm run check:licenses        # root: gates CI
```
Headless smoke test (no live node needed — confirms the module graph mounts):
```
cd packages/web && (npx vite preview --port 4321 &) ; sleep 3
# playwright is at /home/user/mesh/node_modules/playwright (CommonJS: import default)
# chromium at /opt/pw-browsers/chromium-*/chrome-linux/chrome
# goto http://localhost:4321/next/ ; assert content mounts and no non-network console errors
```
Commit style: end messages with the repo's `Co-Authored-By` / `Claude-Session`
trailers (see recent commits). Commit incrementally, one feature per commit.

**Scope decision from the product owner**
- **No workspace/folder picker.** We only support a GitHub **repo** for a session.
- **Starting a session without a repo must work** (this already works: the repo
  pill's "No repo" option leaves `draftRepo = null` and `session.new` omits
  `repo`). Add an acceptance check that a no-repo session still creates and runs.
- Therefore: do NOT wire `workspaces.list`. Ignore that legacy picker entirely.

---

## P0 — functional parity

### P0.1 Session lifecycle actions (rename / delete / pause / resume / open PR)

Backend + protocol already exist; there is no UI. Legacy exposed a per-session
`…` actions menu plus composer pause/resume.

**Commands** (already typed in `protocol.ts`; `DirectTransport` already maps
rename/delete/pause/resume; verify `session.pr.open` mapping exists — it emits
`session.pr_result`):
- `{kind:"session.rename", sessionId, name}` → POST `/api/sessions/rename`
- `{kind:"session.delete", sessionId, path}` → POST `/api/sessions/delete`
- `{kind:"session.pause"|"session.resume", sessionId}` → emits
  `session.paused`/`session.resumed`
- `{kind:"session.pr.open", sessionId}` → emits `session.pr_result {sessionId,…}`

**Store (`packages/core/src/store.ts`)**
- Track paused sessions: add `pausedSessionIds: string[]` (or a `paused` flag on
  the active session) and set it in the existing `session.paused`/`session.resumed`
  cases (currently no-ops at ~line 311).
- Handle `session.pr_result`: set a transient `prResult: {url?, error?} | null`
  the UI can toast, or fold a PR URL into `github.prUrl`.
- After rename/delete, the node broadcasts a fresh `sessions.list`; if not,
  re-request it in the controller.

**Controller (`controller.ts`)** — add methods:
`renameSession(id, name)`, `deleteSession(id)`, `pauseSession(id)`,
`resumeSession(id)`, `openPr(id)`. After delete, if `id === activeSessionId`
call `store.resetActiveSession()`. After rename/delete, `refreshSessions()`.

**UI**
- `components/SessionList.tsx`: add a per-row `…` button opening a small menu
  (reuse `Sheet` or a popover) with Rename (inline input or prompt), Delete
  (confirm), and — when the row is the GitHub session — Open PR. Keep the row's
  primary tap = open.
- Composer (`components/Composer.tsx`): while `working`, show Pause; while the
  active session is paused, show Resume (drive from the new store state). These
  sit next to the Stop button.

**Acceptance**: rename updates the list + title; delete removes it and clears the
view if active; pause/resume toggles and the node reflects it; Open PR opens the
returned URL (or shows the error).

### P0.2 Composer attachments

The paperclip in the composer isn't ported. `prompt` already accepts
`attachments` + `clientMessageId`.

**Discovery first**: read the node's `/api/session/prompt` handler in
`src/server.ts` to confirm the exact attachment shape (likely
`{name, mimeType, data(base64)}` or an array of such). Match it exactly.

**UI (`components/Composer.tsx`)**
- Add a paperclip button + hidden `<input type="file" multiple>`.
- Read files (FileReader → base64), render removable chips above the textarea,
  keep them in local state.
- On send, include `attachments` (and a generated `clientMessageId`) in the
  `prompt`/`session.new` payload; clear chips after send.
- Optionally cap size/count and show a friendly error.

**Controller/core**: extend `sendPrompt(text, attachments?)` to thread
`attachments` into the `prompt` and first-message `session.new` payloads.

**Acceptance**: attaching an image/file sends it; the assistant can reference it;
chips clear after send.

### P0.3 Usage / cost / plan-quota display

Legacy renders usage from `session.usage` events and the `usage` field on
`session.history`.

**Shape** (from legacy `formatUsageMessage`):
`usage = { costUsd?, tokens?:{total}, plan?:{subscriptionType, windows:[{label, utilizationPct, resetsAt}]} }`

**Store**: add `usage: Usage | null`; set it from a new `session.usage` case and
from `usage` on the `session.history` case. Reset on session switch.

**UI**: a compact, dismissable usage line (cost + token total + the nearest
plan-quota window) — a thin bar under the topbar or a chip in the header. Don't
render it as a chat message (the React transcript is derived state); keep it in
chrome. Guard on `usage != null`.

**Acceptance**: after a turn, cost/tokens (and OAuth-plan quota when present)
appear and update.

### P0.4 Email magic-link sign-in

`SetupNotice.tsx` only offers GitHub OAuth. Legacy `showLogin` also had email
magic-link: POST `/auth/magic-link/start {email}`.

**UI (`components/SetupNotice.tsx`)**: below the GitHub button add an email input
+ "Email me a link" that POSTs to `${origin}/auth/magic-link/start`. Show a
"check your email" confirmation. (Add a small `startMagicLink(email)` helper in
`account.ts` if you want it in core; a direct fetch in the component is fine too.)

**Acceptance**: submitting an email hits the endpoint and shows confirmation.

---

## P1 — robustness (refinements over a working baseline)

### P1.1 Persistent history cache + append backfill
The current transcript cache (`SessionStore.transcriptCache`) is in-memory.
Port the legacy IndexedDB transcript cache (`public/app/transcript-cache.js`):
store `{sessionId, messages, count, historyHash}`, and change
`controller.openSession` to send `{kind:"history", have, haveToken}` so the node
replies `mode:"append"` with only the tail. Handle `mode:"append"` in the
`session.history` reducer (merge onto the cached prefix; on hash mismatch, request
full history). This makes switches instant across reloads and cheap on reconnect.

### P1.2 Streaming reasoning (`thinking_delta`)
`SessionStore.applyStreamEvent` handles thinking only when it arrives inside a
message. Add cases for standalone `thinking_delta` / `thinking_end` (see legacy
`streamThinking`) so agents that stream reasoning separately render it live via
the existing thinking-draft path (`upsertDraft("thinking", …)`).

### P1.3 Multi-client focus arbitration / deferred-history
Port the legacy focus guards + deferred-history ordering (remote-app.js
~2829–2907) so a session driven from two devices doesn't flicker mid-turn and a
canonical `session.history` mid-stream doesn't clobber live tool/output. This is
the last correctness item from STATUS.md.

---

## P2 — polish

- **Model picker "Connect a provider" rows**: in `components/Pickers.tsx`
  `ModelPicker`, list `state.providers` that need connecting and route to the
  provider connect flow (reuse Settings' `ProvidersPanel` logic), so a fresh node
  isn't a dead end.
- ~~**Per-message copy button** on assistant messages (copy raw markdown), hover-
  revealed. See legacy `addCopyActions`.~~ Done — see `STATUS.md`.
- **Agent-switch transcript handoff**: `controller.chooseAgent` currently starts a
  fresh session on a live-session agent change. Optionally build a handoff prompt
  from the current transcript (legacy `transcriptForHandoff`) so context carries.
- **TUI composer lock**: handle `terminal.tui {sessionId, active}` to disable the
  composer with a banner while a session is in interactive TUI mode.
- **Live current-node dot**: `NodeSwitcher` shows `n.online` from `/nodes`; for
  the *current* node, drive the dot from live connection status.
- **QR camera scan**: Settings → Link a device is paste-only; add a
  `BarcodeDetector` camera path with graceful fallback.
- **Approval critical vs remember**: only offer "Always allow"/remember for
  non-critical approvals (legacy gates the remember checkbox on criticality).
- **Node-broker ephemeral exec**: `packages/core/src/ephemeral.ts` only wires the
  cloud-relay `exec`. Add the E2E node-broker transport (`ephemeral.exec` frame →
  `ephemeral.exec.result`), routed like terminal events through a controller
  listener, for the strongest-privacy path.

---

## Suggested order & commits
1. P0.1 session actions (store + controller + SessionList menu + composer
   pause/resume) — one or two commits.
2. P0.3 usage display.
3. P0.2 attachments (discover node shape first).
4. P0.4 magic-link.
5. P1.1 persistent history cache + append (bigger; own commit).
6. P1.2, P1.3, then P2 as time allows.

Keep `packages/web/STATUS.md` updated as items land, and check items off the
PR #223 description.
