# Live Previews — feature synthesis

Status: proposal · 2026-09-25 · combines the "mirror" and "two-ink" concepts in
this directory into one feature.

## Pitch

The moment an agent starts a server, you can see the app on your phone. You can
keep it on your home screen, point at what's wrong, and see what changed since
the last turn, all without leaving the chat.

**Principle:** a preview is a place you stay in, not a link you open.

## The problem

The transport works today: relay tunnels, per-view origins, one-use grants, and
HMR over WebSockets. What doesn't work is the experience around it. On a phone,
one preview currently costs about 8 steps and 3 app switches:

1. Ask the agent to start a server.
2. Ask it to write `bivy.app.json`.
3. Ask it to run `bivy app publish`.
4. Find the Open app card in the chat.
5. Leave the PWA for a new tab.
6. Hit a blank frame when the server has died.
7. Describe the bug in words.
8. Lose the preview: links last 24 hours at most, and a restart clears
   everything.

**Target:** 2 taps and 0 app switches.

## Architecture: four independent building blocks

Each block ships and works on its own. The ten moves from the concepts are
combinations of these blocks.

```
 detection ──► surface ◄── inspector
     │            ▲
     └──► history ┘
```

### 1. Detection: previews appear by themselves (`src/apps/`)

- **Listener discovery.** Loopback listeners owned by the session PTY's
  descendants become `preview.available` offers. On Linux this uses
  `/proc/net/tcp{,6}` plus a pid walk; on macOS, `lsof`. An offer is not a
  grant: access still starts only when a user taps.
- **Optional manifest.** `bivy.app.json` stays, but only for view names,
  terminal views, static snapshots, and `start`.
- **Managed start (phase 3).** Adds `"start": { "command", "args", "cwd" }` to
  web service views. Bivy owns the process: logs go to a ring buffer, it
  restarts with backoff, and the registration is persisted and restored on boot.
  A registration is only rebound if the port is owned by the same process tree
  (no reattaching to a stranger's server).
- **Typed health.** The gateway reports one of: `starting | live |
  not-answering(lastLogLines) | removed`. The shell renders a state for each.
  Every non-live state has an **Ask agent to fix** button that pre-fills the
  composer.

### 2. Surface: one preview in three sizes (`packages/web`, `preview-shell.ts`)

- **Peek.** A drawer over the chat on phones and a split pane on desktop. It
  frames the shell origin using `Partitioned` (CHIPS) grant cookies. If the
  browser refuses those cookies, it falls back to today's separate tab.
- **Full screen / home screen.** A *stable per-project address*, derived from
  the node identity and project. It is authorized by the paired device's
  identity, not by a bearer link. Adding it to the home screen once means it
  always opens the latest turn. The 24-hour copyable links stay, only for
  sharing with others.
- **Floating pill.** This replaces the preview-shell header. It shows the app
  name, the turn it reflects, and an error count, plus **Point / Compare / Lens
  / Chat** buttons. The app keeps its own header and the full screen. The
  RunPill action sheet remains the list of all apps.

### 3. Inspector: one script behind four features (`gateway.ts`)

The gateway injects one small script into proxied HTML, on the *app's* origin.
It sends `postMessage` only to a shell that checks the sender's origin. It
powers:

| Feature | What it does |
|---|---|
| Point and tell | Tapping an element drafts the selector, a screenshot crop, the viewport, the route, and recent errors |
| Console / errors | A capped, summarized stream of `console.*`, `error`, `unhandledrejection`, and fetch timings, shown in a drawer and as a pill badge. It also appears in the chat's RunPill as "N errors in Ledger" |
| Device lens | Light/dark flip and a safe-area overlay. Width switching is handled by the shell alone |
| Reviewer pins | On share links, pins from teammates come back into the session as notes |

**Hard rule:** anything captured from an app only becomes a *draft*. App content
is untrusted, and nothing reaches the agent until a person sends it.

### 4. History: what changed (node + web)

- **Turn stamps.** When a turn ends, open previews reload and static views
  re-snapshot. The pill reads "turn 14 · 3s ago".
- **Per-turn snapshots.** Keep the last N per view: the bytes for static views,
  a screenshot for service views. This stays within the existing 100 MiB budget,
  evicting the oldest first.
- **Compare.** The default is a swipe divider. An overprint toggle overlays the
  two versions in two tints, so unchanged pixels merge and layout shifts stand
  out.
- **Agent eyes.** `bivy app shot --widths 390,1280 --themes light,dark` runs a
  headless browser through the gateway. It is off by default on self-hosted
  nodes and runs shots sequentially. It also provides the screenshots for
  Compare and for "turn 14 ready · 0 errors · checked at 390/1280"
  notifications.

## Contract changes

| Area | Change |
|---|---|
| `packages/core/src/apps.ts` | `AppViewSpec.web` gains optional `start`, `spaFallback`; `SessionApp` gains `origin: "manifest" \| "detected"`, `health`, `turn` |
| Commands (`src/controllers/app-commands.ts`) | `apps.offers` (detected listeners), `apps.adopt` (offer → app), `apps.snapshots`, `apps.shot`; existing `open/share/revoke/remove` unchanged |
| Events | `preview.available`, `preview.health`, `preview.refreshed{turn}`, `preview.errors{count}` via the existing fold (mirrors `deriveArtifacts`) |
| Relay | Stable per-project hostname allocation and device-bound grant (phase 3) |
| CLI | `bivy app shot`; `bivy app publish` still works as today |

No per-agent code. Everything is built from the process tree, HTTP, transcript
turn boundaries, and the CLI.

## Plan

| Phase | Ships | Done when |
|---|---|---|
| **1: close the loop** (~2 wks) | Listener detection + adopt · typed health + SPA fallback · turn-stamped reload · hand-off via the existing **Copy link** (QR deferred) | The first preview needs no manifest; a dead server shows a cause and a fix button, never a blank frame |
| **2: hold it** (~4 wks) | Peek drawer / split pane · floating pill · inspector (point and tell, console, lens) | A UI bug can be found, pointed at, and sent from a phone without typing a description |
| **3: keep it** (~6 wks) | Managed start + persistence · stable home-screen address · snapshots + Compare · `bivy app shot` · reviewer pins | A preview added to the home screen on Tuesday opens the latest turn on Wednesday, even after a reboot |

Suggested first PRs, in this order:

1. Listener detection → offers.
2. Typed health states in the shell.
3. Turn-stamped reload.
4. SPA fallback. Hand-off uses the existing **Copy link**; QR is deferred.

Each PR is small and independent.

## Success metrics

- Under 5 s from "turn done" to pixels on the phone.
- 0 manifests needed for a first preview.
- Under 2% of opens landing on a blank or error frame.
- 1 in 3 UI follow-ups sent via Point instead of typed.
- 7-day median lifetime of a home-screen preview.

## Guardrails

- The shell and app origins stay split. App code never sees Bivy device
  credentials or the preview cookie.
- Detection offers a preview; it never publishes one.
- Stable does not mean public: the per-project address works only on paired
  devices. Share links stay time-limited and revocable.
- Preview traffic is still not end-to-end encrypted, and `docs/apps.md` keeps
  saying so.
- The UI uses `packages/ui/tokens.css` and existing primitives (Sheet, btn,
  status). The concept palettes are mood only.

## Open decisions

1. **Stable address auth:** paired devices only (recommended), or also passkey
   sign-in so it can replace share links for teammates?
2. **Peek on iOS:** confirm that Safari's `Partitioned` cookie behavior works
   in a framed, cross-site shell before committing Peek as the default there.
   Otherwise, iOS keeps the tab fallback.
3. **Agent eyes default:** off on self-hosted nodes. Should it be on by default
   on managed compute?
