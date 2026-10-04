# Session apps and views

Bivy apps group interfaces to what an agent is building. An app is **not** an
HTML document or a particular framework: it has named, typed views. Version 1
supports web, interactive terminal and desktop (display) views. A desktop view
is shown through the same web preview, so it adds no new app category.

## Publish from any agent

Write `bivy.app.json` in the project:

```json
{
  "version": 1,
  "name": "Accounting app",
  "views": [
    {
      "kind": "web",
      "name": "Website",
      "source": { "kind": "service", "port": 3000 }
    },
    {
      "kind": "terminal",
      "name": "Rails console",
      "command": "bin/rails",
      "args": ["console"]
    }
  ]
}
```

```sh
# Start the web server using your normal development workflow:
bin/rails server --binding 127.0.0.1 --port 3000

# From another terminal, or have the agent publish after starting the server:
bivy app publish bivy.app.json --session <session-id>
bivy app list --session <session-id>
bivy app remove <app-id> --session <session-id>
```

### Detected servers (no manifest)

A manifest is optional for a single live server. When a process whose working
directory is inside the session workspace listens on loopback (`127.0.0.1`,
`::1`) or all interfaces, session menu → **Apps** lists it under **Running in
this workspace**. Tapping **Preview** publishes it as a one-view app and opens
it. Detection grants nothing on its own: access starts only when someone taps,
and the node re-checks that the port is still a workspace listener before it
publishes (`apps.offers` / `apps.adopt`). Detection reads `/proc` on Linux and
uses `lsof` on macOS. It sees only processes owned by the node's user and ports
from 1024 up. Use a manifest to name views, add terminals or publish static
snapshots.

Inside an agent session, `--session` defaults to the same session environment used
by `bivy attach`. No per-agent adapter or special model tool is required.
`bivy app --help` describes the contract. The CLI prints JSON, including app and
view IDs. API callers can use the same `apps.publish/list/open/remove` commands.

Publishing adds a durable **Open app** button to the chat. You can also use the
session menu → **Apps**. Both open the same view selector. **Open preview**
**peeks**: the preview opens in a drawer over the chat, with Bivy's controls in a
floating pill (see [Preview controls](#preview-controls)) and the composer still
reachable. **Open in tab ↗** opens the same preview in a separate tab. If the
browser blocks popups, a normal link is offered instead. In a tab, **Back to
chat** closes it where permitted, otherwise navigates to the originating
session. Closing the view does not stop an external app server.

The drawer and the tab both host a Bivy-owned shell on its own origin, and the
generated app is framed on a separate, same-site origin, so app code never
reaches Bivy's controls. Inside the drawer, the app's access cookie is a
third-party cookie. The embedded launch therefore sets it `SameSite=None;
Partitioned`, keyed to Bivy's top-level site, so no other site can use it. The
app's own cookies are third-party there too, so in the drawer the gateway
partitions them the same way (`Secure; SameSite=None; Partitioned`), whether
its server or its scripts set them: sign-ins and carts work in Safari, which
keeps only partitioned third-party cookies (iOS/Safari 26.2 and later). The
shell may be framed only by the configured Bivy client origins and Bivy's
packaged apps (`capacitor://localhost`). Browsers that refuse framed cookies
are detected on the first try. That browser version then opens previews in a
tab for a week; an update gets the drawer back. The Bivy client's CSP allows HTTPS frames
(`frame-src 'self' https:`) for this. Terminal views ask for confirmation,
then open inside Bivy's existing terminal with input, output, resizing and mobile
controls. Chat launchers survive reload, but opening a removed app or one cleared
by a machine restart reports that it needs republishing.

Publishing never starts terminal commands. Opening a terminal view starts its
program once; concurrent opens and subsequent opens reconnect to it. Once the
program exits, opening the view again starts a new instance. Closing the terminal
UI detaches; ending the terminal stops it. An exited app never silently becomes a
shell. Commands are executables plus argument arrays, not implicitly shell-parsed
strings. For shell syntax, explicitly choose a shell and `-c` arguments.

### Agent screenshots (`bivy app shot`)

```sh
bivy app shot                       # every web view: 390 and 1280 px, light
bivy app shot <app-id> --widths 390 --themes light,dark --path /settings
```

Any agent can screenshot its session's web views to check its own UI (desktop
apps: see [Desktop apps](#desktop-apps-display)). The
command prints JSON with one PNG path per view, width and theme. Phone widths
(< 600 px) render at 2×. Themes are emulated for the page
(`prefers-color-scheme`). It uses Chrome or Chromium on the machine
(`BIVY_CHROME` to pick one; a Playwright install also works), one browser at a
time, and needs a few hundred MB of memory while it runs. Service views load
straight from loopback; static views from a temporary loopback server. Where
Chromium's sandbox is unavailable (as root, or where AppArmor blocks user
namespaces), it runs without it. The pages are the session's own apps, already
running as the node user.

**Off by default.** Turn it on in Bivy → Settings → this machine, *Let agents
screenshot their app previews*. From a terminal, run
`bivy config set sessions.appScreenshots true` (or set
`BIVY_APP_SCREENSHOTS=1`). While it's off, the command explains how to turn it
on.

### Review cards (`bivy app present`)

```sh
bivy app present                                  # the view opened last
bivy app present Storefront --path /checkout --note "New pay button"
```

A review card shows the running app in the chat when there is something to
judge: the app at phone width, a **Before / Now** switch when the run changed
it, and **Open preview**, which opens the live preview on that page. There is
one card per app per run; later changes in the same run update it in place.
A card appears when:

1. **The agent presents it.** `bivy app present` means "this is ready to look
   at". Any agent can run it, and users can ask for it ("show me when it's
   ready"). It first picks up files written since the turn began, so the
   picture and any open preview show them. It prints JSON with the card and a
   message saying what the user will see.
2. **A run ends with a visible change.** When the agent stops (done, or
   waiting for the user), each web view whose revision changed during the run
   is screenshotted and compared with the page before the run. A card is made
   only if enough pixels differ. A backend-only run makes no card.
3. **The user asks.** *Show me the app* in the session menu, or on a
   "finished" notification (where the device supports notification actions),
   takes one now.

**Preview cards: When ready · Every change · Off**, per app, in the app's ⋯
menu (Apps sheet) or the card's ⋯ menu, and remembered with the app. *When
ready* is the default (triggers 1 and 2, above a small threshold of changed
pixels, about a changed label). *Every change* also shows small visual tweaks.
*Off* makes no cards on its own; Show me still works. **Mute for this run** on
a card stops further cards until the agent's next run.

Cards need agent screenshots (see above). While they're off, a presented or
requested card has no picture and offers **Turn on**; Bivy never turns
screenshots on by itself. To measure a change, Bivy needs the page as it was
before the run: the screenshot from the previous run or Compare, or, the first
time, one taken when the run starts.

**Notifications.** There is no new notification. When nobody has the session
open, the existing "finished" notification says the app changed and opens the
card. It carries IDs only, never the image: the screenshot is an encrypted
chat attachment the device fetches over the session channel. It waits up to
30 seconds for the card.

**Storage.** Screenshots are stored like other chat attachments (end-to-end
encrypted in transit, in the node's attachment store). Each view keeps only
its latest card's pictures: an older card shows "Screenshot no longer stored".

### Scenarios

A scenario is a named starting point for the live app: a page, steps a person
would take there, and API responses Bivy simulates. In the preview you open
one, use the app normally, and tap **↺** to start it over. Scenarios live in
the project, one file each, so agents and people share them:

```jsonc
// .bivy/scenarios/payment-api-down.json
{
  "name": "Payment API down",
  "description": "Checkout while payments fail",
  "open": "/checkout",
  "steps": [{ "fill": "#email", "with": "ada@example.com" }, { "click": "text=Pay" }],
  "network": [{ "match": "POST /api/payments*", "status": 503, "json": { "error": "down" } }]
}
```

Only `name` is required. The file name, without `.json`, is the scenario's ID
(lowercase letters, digits and dashes).

| Field | What it does |
| --- | --- |
| `open` | The page it starts on (default `/`). |
| `steps` | Taken in order on the page, like a person would. `{"click": sel}`, `{"fill": sel, "with": "text"}`, `{"press": "Enter"}`, `{"wait": sel}` or `{"wait": ms}`. `sel` is a CSS selector, or `text=Visible text` for a button, link or label. Each waits up to 5 seconds for its element. A step that loads a new page is followed by the rest on that page. |
| `network` | Rules for this viewer's requests, first match wins. `match` is an optional method and a path, where `*` matches anything. Answer with `status` and `json` or `body`; add `delayMs` (up to 30 s) to answer late, or use it alone to let the request through late; `"offline": true` drops the connection. |
| `from` | Another scenario's ID to start from: its page and steps run first, and this one's rules win over its rules. |
| `fresh` | `true` starts as a new visitor: the app's cookies and storage in this browser are cleared first. |
| `view` | The app or view name it's for. Without it, it applies to every web view of the app. |
| `description` | One line, shown under its name. |

**Desktop apps.** A desktop app (a `display` view) is one program for everyone
watching it, so its scenario is the app's, not one viewer's: opening one
restarts the app in it, and the steps run in its window before the preview
says it's ready. After a turn that restarts the app (`restartOnChange`), it
comes back in the same scenario, steps and all.

| Field | What it does |
| --- | --- |
| `args` | Added to the app's command, e.g. `["--open", "demo.ledger"]`. |
| `env` | Added to its environment, e.g. `{"FEATURE_NEW_TILL": "1"}`. The display's own variables always win. |
| `api` | `{"env": "API_URL", "target": "http://127.0.0.1:4000"}`: the app is started with `API_URL` pointing at a Bivy proxy on loopback, which answers by the `network` rules and passes everything else to `target`. Required for `network` rules, since a desktop app calls its API directly. |
| `steps` | `{"click": [x, y]}` in the pixels of `bivy app shot`, `{"type": "text"}`, `{"press": "cmd+s"}`, `{"menu": "File > Open"}` (macOS), `{"wait": ms}`. |

A scenario is for web pages or for desktop apps, never both: `open`, `fresh`,
selector steps and `fill` are web-only; `args`, `env`, `api`, pixel clicks,
`type` and `menu` are desktop-only. Each view lists only the scenarios it can
take; one that mixes them says so.

**In the preview.** Once a view has scenarios, its title in the pill becomes
the switcher: it names the scenario you're in, and when Bivy is simulating a
response, the line under it says what ("Simulated: POST /api/payments* →
503"). **↺** opens the scenario again from its first page. **Your data** leaves
it. Scenarios changed since the app was published are listed first as *New in
this session*. A file that can't be read, or a scenario whose step can't find
its element, says what's wrong and offers **Ask agent to fix**, which drafts a
message naming the file and the step. You stay where it got to.

**Per viewer (web pages).** Network rules apply only to requests from the browser that
opened the scenario, through Bivy's preview gateway. Other viewers, and the
app's server, see nothing. Simulated responses carry `x-bivy-simulated: 1`.
WebSocket traffic isn't simulated. The scenario lasts for that browser's
preview session; opening a fresh preview starts outside any scenario.

**For agents.** `bivy app scenarios [view]` lists a view's scenarios as JSON,
including files that can't be opened and why. `bivy app present --try
payment-api-down,empty-cart` puts **Try it** buttons on the review card; each
opens the live preview in that scenario.

### Pins

Marks sent from a preview become a **pin**: a card in the chat holding the crop
of what was marked, the words that were sent with it, and a state. A message
carrying several numbered notes makes one pin per note, each with its own crop,
its own number and its own answer. The message
they travelled in is unchanged — the agent still reads the words, the context
and the full picture — but a message says nothing about itself afterwards, and a
pin does.

A pin is made only when the message is actually sent, so nothing appears in the
chat that nobody sent. It keeps the place it was made and only its state moves:

| State | What it means |
| --- | --- |
| **Open** | Nothing has changed where it points. |
| **Changed** | A later run changed the pixels it marked. |
| **Element gone** | Everything it named has left the page. |
| **Done** | The person said so (and can reopen it). |

Only evidence moves a pin off **Open**: a run that changes nothing there leaves
it open, because it has not been answered. The evidence is the run's own
before/after screenshots, compared inside the marked region alone, plus a check
of whether the marked elements still match anything on the page. Turning preview
cards off stops the cards, not the answers — pins on that app are still resolved.

Two things a pin does not claim: a pin marked at a viewport width far from the
390 px the run screenshots use sat on a different layout, so its region is not
compared and it stays open; and with agent screenshots off there are no pictures
to compare, so pins stay open until marked done. Pins live in the node's memory
and their pictures in the attachment store; the card survives a reload through
the session's event log.

### Share links (`bivy app share`)

```sh
bivy app share                          # the web view opened last
bivy app share Shop --view Storefront   # an app and view, by name or ID
bivy app share --for 7d --view-only     # a week, without the feedback tools
```

Mints the same reusable link as **Copy link** in the Apps sheet (see
[Automatic web preview delivery](#automatic-web-preview-delivery)), so an agent
can hand a preview to people outside Bivy: in a pull request, an issue, or a
Basecamp or Slack thread an automation came from. `[app-id]` is an app ID or
name and `--view` a view ID or name within it; with neither, it picks the view
opened last, like `bivy app present`. Only web views have links. It prints JSON
with `url`, `expiresAt` (epoch milliseconds), `expires` (ISO 8601) and the app
and view it picked:

```json
{ "url": "https://view-<view>.preview.example.net/__bivy/open#…", "expiresAt": 1790532000000,
  "appId": "…", "viewId": "…", "app": "Shop", "view": "Storefront",
  "expires": "2026-09-27T18:00:00.000Z" }
```

The link works for `--for` (`1h`, `1d` or `7d`; default `1d`), until the user
stops sharing in the Apps sheet, until the app is removed, or until the machine
restarts. People who open it can leave reviewer notes, which come back under the
view in **Apps**; with `--view-only` they see just the app, without marking
or notes. The JSON also carries `controls` (whether the link has the feedback
tools).

People who open a share link see a small **Made with Bivy** strip under the app,
linking to bivy.sh. Your own previews never show it. A machine can turn it off
with `bivy config set sessions.previewBadge false` (or `BIVY_PREVIEW_BADGE=0`).
A control plane can limit that to accounts on certain plans by listing them in
`BIVY_PREVIEW_BADGE_HIDE_PLANS` (for example `individual,pro,team`); when it is
unset, or the machine has no control plane, every machine decides for itself.

> **Security:** a share link is a bearer capability. **Anyone who has the link
> can use the app, including its live backend, until it expires or you revoke
> it.** Posting it in a thread, issue or chat gives it to everyone who can read
> that place, and to any integration or log that stores it. Only share previews
> whose data and actions are fine for those people, and revoke access when the
> review is done. The command prints this reminder on stderr, so the JSON on
> stdout stays clean for scripts.

### Reviewer notes for agents (`bivy app notes`)

```sh
bivy app notes                                 # the web view opened last
bivy app notes Shop --view Storefront --since 2026-09-27T09:00:00Z
```

Prints the reviewer notes on one web view as JSON (`app`, `view`, `untrusted:
true`, `notes` with text, element, page, viewport and time), so an automation
can report them, for example back to the Basecamp or Slack thread the work came
from. `[app-id]` and `--view` pick the view like `bivy app share`; `--since`
(ISO time or epoch milliseconds) returns only newer notes. Reading doesn't clear
them.

**Off by default, per app.** The owner turns it on in **Apps → the app's ⋯ →
Agents can read notes**; until then the command explains where. Only the app
sets it: a manifest can't, and there is no CLI for it.

> **Untrusted input.** Anyone with a share link can write a note, including
> text meant to steer the agent ("ignore your instructions and…"). Turning this
> on lets that text into the agent's context, like a webhook payload. Tell the
> agent to treat notes as data to report or weigh, never as instructions; the
> command prints that reminder on stderr. This switch keeps notes out of agents
> by default; it is not a boundary against an agent that already runs as you
> on the machine.

### Servers Bivy runs (`start`)

A service view can say how to start its server:

```json
{ "kind": "service", "port": 5173, "start": { "command": "pnpm", "args": ["dev", "--port", "5173"] } }
```

Publishing still starts nothing. The first **Open preview** starts the command
in the session workspace, in a Bivy terminal, with the node user's permissions,
the same as a terminal view. The preview shows *Nothing is answering* until the
server listens, then reloads. If the server exits, Bivy restarts it. After five
restarts in ten minutes it is left down until someone opens the view again.
**Logs** in the Apps sheet attaches to its output. Removing the app stops it.

### Desktop apps (`display`)

A desktop GUI program (GTK, Qt, Electron, Tauri, Flutter desktop, Java, SDL,
and on a Mac also AppKit and SwiftUI…) is a view too, on Linux and macOS:

```json
{ "kind": "display", "name": "Editor", "command": "cargo", "args": ["run"], "restartOnChange": true }
```

Without a manifest: `bivy app run -- cargo run` publishes the same thing
(`--name` names it, `--restart-on-change` sets the flag).

The first **Open preview** starts a private display for the view, then runs the
command on it in a Bivy terminal, like a server with `start`: **Logs** shows its
output, it restarts if it exits, and removing the app stops both. With
`restartOnChange`, an agent turn that changed files restarts it too, so it runs
the new code, and Compare gets a before/after pair. The preview streams the
display into the usual shell, so Peek, **Open in tab**, the stable address and
**Copy link** work as for web views. **Console** and reviewer notes need a page
to inspect, so they're not offered; marking works on the streamed frame, which
is exactly what you saw.

The display follows the viewer: it takes the preview's size (a phone gets a
phone-sized screen), each app window fills it, and dialogs stay their own size,
centered. A window that can't shrink that far makes the display larger instead,
and the preview scales it down to fit, so nothing is cut off. On a
high-density screen the display starts at 2× (toolkits get `GDK_SCALE=2`,
`QT_SCALE_FACTOR=2`, `J2D_UISCALE=2`, and `Xft.dpi: 192` for Chromium/Electron),
so text stays sharp; the density is fixed when the display starts, by the first
device that opens it.

- **Clipboard:** text the app copies shows **Copy from app**; tap it to put it
  on your device. **Paste** sends your device's text to the app and presses
  Ctrl+V. Where the browser won't share its clipboard, a field opens to paste
  into. Nothing crosses without a tap.
- **Keyboard:** on touch screens, **⌨** opens the on-screen keyboard.
- **Screenshots:** `bivy app shot` captures the display as it is, without a
  browser: one PNG at its current size (`"theme": "native"`); `--widths` and
  `--themes` don't apply. It waits up to 15 seconds for the app's first window.
- **Stream stats:** each viewer reports input-to-frame latency (median and
  p95) and bandwidth every 10 seconds while you use it; `bivy app list` shows
  the latest as the view's `stats`.

#### Agents using the app (computer use)

An agent can use its desktop app the way you would, in the pixels of the
app's screenshot:

```sh
bivy app shot                        # see it: prints the PNG path and size
bivy app click 412 230               # --right, --middle, --double
bivy app type "hello world"
bivy app key cmd+s                   # enter, tab, escape, arrows, f1–f12…
bivy app scroll 400 300 --down --steps 5
bivy app drag 100 100 300 240
bivy app menu                        # macOS: the menu bar, with shortcuts
bivy app menu "File > Export…"       # choose an item
```

Each command sends the same pointer and key events a viewer sends, to the
app's display only, and prints the app as it looks afterwards (`shot`), so the
agent sees what its action did. `--app` picks the app by name or ID (default:
the desktop app opened last); the app is started if it isn't running. A point
outside the app is refused with the app's size. Modifiers are `shift`,
`ctrl`, `alt`/`option` and `cmd` (⌘ on a Mac, Super on Linux). On a Mac,
choosing a menu item by its path is more reliable than clicking, and works
whatever is on screen. The pictures need agent screenshots on (see above); the
actions themselves don't.

#### Linux

Requires TigerVNC's X server on the machine (Debian/Ubuntu:
`sudo apt install tigervnc-standalone-server`, or set `BIVY_XVNC` to an `Xvnc`
binary). Publishing says so when it's missing. Programs get `DISPLAY`,
`XAUTHORITY` and toolkit hints (`GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`,
`SDL_VIDEODRIVER=x11`, `ELECTRON_OZONE_PLATFORM_HINT=x11`), so they use the
preview display rather than the machine's own. Each display costs about 30 MB
plus the app. Not yet: sound and Wayland-only apps.

#### macOS

A Mac has no private displays, so the app runs on the Mac's own screen and the
preview shows **only that app's windows**: its largest window is the picture,
and its dialogs, sheets and menus are drawn over it. Nothing else on the
screen is captured. Everything above works the same: sizing to the viewer,
2× on high-density devices, clipboard (Paste presses ⌘V), screenshots,
Compare, restart on change, and agent input.

- **Which windows:** Bivy starts the command through its helper, which stays
  its parent, with `BIVY_MAC_DISPLAY` in its environment. Windows of the
  program and anything it starts are shown (`swift run`, `npm start` →
  Electron, `cargo run`, `flutter run -d macos`,
  `./MyApp.app/Contents/MacOS/MyApp`), including signed apps that hide their
  environment. An app launched through `open` or Launch Services isn't a
  descendant, so run the binary directly (sandboxed App Store apps can't be
  run that way).
- **Sizing:** the app's main window moves to the top-left of the screen and
  takes the viewer's size, up to the visible screen. A window with a larger
  minimum size stays larger and the preview scales it down.
- **Input:** keys go to the app's process only. Clicks and scrolls move the
  Mac's own pointer, and the app comes to the front first; a click lands only
  if the app's window is the one under it, never on something covering it.
  Hovering moves the pointer only over the app. The clipboard is the Mac's
  own: pasting from a viewer replaces it, and "Copy from app" offers text
  copied while the app is in front.
- **Permissions:** a small helper, built from source with Apple's command
  line tools (`xcode-select --install`) on first use and kept in Bivy's data
  directory, captures the app with ScreenCaptureKit and sends input with
  Accessibility. Allow **Screen Recording** and **Accessibility** in System
  Settings → Privacy & Security for the program that runs Bivy (your terminal
  app, or `node` when Bivy runs as a background service), then restart Bivy.
  Publishing says what's missing, and the first open asks macOS to prompt.
- **Menu bar:** the preview shows only the app's windows, so its menu bar
  comes through **Menu** in the viewer instead: the app's menus, read when you
  open it (so enabled items and check marks are current), with their
  shortcuts. Drill into submenus and tap an item to choose it; nothing moves
  the pointer. Arrow keys move through items and Escape goes back.
- **Full screen:** the preview already sizes the app to your screen, so the
  app's own full screen (its own Space on the Mac) is switched off when it
  enters it, and the window is fitted to the viewer again.
- Requires macOS 13 or later. The Mac must be logged in with its screen
  unlocked, as for any app you want to see. Not yet: sound, and games that
  take over the whole display.

### Static sites

Replace the web source with:

```json
{ "kind": "static", "directory": "./dist" }
```

The CLI resolves directories relative to the manifest; direct API callers use
paths relative to the session workspace. The directory must be inside that
workspace and contain `index.html`. Bivy snapshots its bytes at publication, so
edits in the middle of a turn never change the published view. When an agent turn
finishes with file changes, Bivy re-takes the snapshot and open previews reload,
returning to the page you were on. A build that no longer produces `index.html`
keeps the last good snapshot. Publish again to update between turns.
Hidden files and `node_modules` are excluded; symlinks and special files are
rejected. Limits: 25 MiB / 2,000 files per snapshot, 100 MiB total static data,
50 apps per node, and 8 views per app. Only publish a dedicated output directory,
not a source tree containing secrets.

Service views instead proxy a live HTTP server on IPv4 loopback. Ports below 1024
and Bivy's API/preview ports are reserved. Use your framework's host allowlist to
permit the preview hostname, configure its external HTTPS URL if required, and
keep the service bound to `127.0.0.1`. HTTP bodies and WebSocket upgrades are
forwarded without an app-specific adapter. Root-relative routes, forms, cookies,
and WebSocket connections can use the view's own origin; hardcoded localhost URLs
and absolute localhost redirects must be fixed in the application's configuration.
Long-lived HTTP streams time out after 60 seconds of inactivity. If nothing is
answering on the port, the preview shows **Nothing is answering on port N**
instead of a blank frame. It reloads by itself once the server is back, and
**Ask agent to fix** opens the session with a drafted request (nothing is sent
until you send it). Service previews also reload after an agent turn that changed
files, for servers without hot reload. Static views
serve client-side routes: an extensionless page load that matches no file gets
`404.html` (with status 404) if the snapshot has one, otherwise `index.html`.
The static server does not provide range requests or directory listings.

## Backend views

A backend change is reviewed by seeing what it did, the way a UI change is
reviewed in its preview. Three view kinds show it, each built from files the
agent keeps in the project:

```jsonc
{ "kind": "requests", "name": "API" }            // .http files in .bivy/requests
{ "kind": "data", "name": "Database",            // .sql files in .bivy/queries
  "command": "sqlite3", "args": ["-readonly", "-json", "db/dev.sqlite3"] }
{ "kind": "logs", "name": "Server log" }         // the app's server output
```

They sit in the same manifest as the app's web views and open from the Apps
sheet. Everything they show is the app's own output, shown as text.

**Before and after each agent run.** When a run starts, Bivy runs the requests
that are safe to run on their own and every saved query. When it ends, it runs
them again. What changed goes on the run's review card, one line each: a request
whose answer changed (`POST Create order 201 → 422`), a query whose rows changed
(`coupons +1 ~1`), and errors the server logged during the run. A run that
changed only the backend gets a card too; without a change there is none. Each
line opens its view at that request or query, where **Changes** compares the
answer or the rows with how they were before the run. *Preview cards: Off* and
*Mute for this run* apply to these cards as well.

### Requests

`.http` files in `dir` (default `.bivy/requests`), in the format VS Code's REST
Client and JetBrains already run:

```http
@token = dev-token

### Create order, expired coupon
POST {{base}}/orders
Authorization: Bearer {{token}}
Content-Type: application/json

{ "items": [42], "coupon": "SPRING" }

### List open orders
# @auto
GET {{base}}/orders?status=open
```

`###` separates requests and names them (`# @name` also works). `{{base}}` is the
app's web server (its first `service` view, as `http://127.0.0.1:<port>`); set
`"base": {"view": "<name>"}` or `"base": {"url": "…"}` to point elsewhere.
`@name = value` lines are variables. Scripts and response handlers are ignored.

- **What runs on its own:** GET and HEAD requests to the app's own server, and
  any request marked `# @auto`. Anything else runs only when you tap it, after
  a confirmation that says what it sends and where. Requests to another host are
  labelled with it.
- Each answer shows its status, time and body (JSON pretty-printed), with
  **Before · Now · Changes**. Changes lists the status and each changed JSON
  path. Redirects are shown, not followed. Requests time out after 10 seconds;
  bodies are cut at 1 MB.
- **Send to agent…** drafts a message with the request and what it answered.

### Data

Saved queries in `dir` (default `.bivy/queries`), one `.sql` file each, run
through the project's own database client. The command gets the query on stdin
and prints rows as JSON (`sqlite3 -json`, `duckdb -json`), CSV (`psql --csv`)
or TSV (`mysql --batch`):

```sql
-- title: Coupons
-- key: code
select code, percent, expires_at from coupons order by code;
```

`-- key:` names the column rows are matched by (default `id`, else the first
column), so **Changes** shows rows added, changed (with the old value struck
through) and removed, not two dumps. **Now** shows the rows (up to 200 of up to
1,000). Queries time out after 15 seconds.

The command runs in the workspace as the machine user. Bivy can't make it
read-only, so open the database that way (`sqlite3 -readonly`, or a Postgres
role with `default_transaction_read_only`). Only saved queries run; there is no
SQL console.

### Logs

A server's output, with each line stamped when it arrived and errors marked
(an "error" or exception, a 5xx it answered; stack frames stay with their
error). By default it's the app's server that Bivy runs (a `service` with
`start`, or a desktop app); `"source"` picks another:

```jsonc
{ "kind": "logs", "name": "API log", "source": { "view": "API" } }
{ "kind": "logs", "name": "Dev log", "source": { "file": "log/development.log" } }
{ "kind": "logs", "name": "Compose", "source": { "command": "docker", "args": ["compose", "logs", "-f", "api"] } }
```

A server's output is followed from when Bivy starts it, so it reaches back
before anyone opened the view. A file or command source starts when the view
is first opened and keeps running. Each action leaves a marker in the log: an
agent run starting, a request you ran, a page you opened or something you sent
from the web preview. The view opens at the last one (*Your last action ·
Ran "Create order"*). **Errors** filters; **Send errors to agent…** drafts the
lines since the last action. Secrets are redacted before anything is shown.

**In the web preview's Console.** Errors that the app's server logged since the
page loaded (from a server Bivy runs, or a logs view of the same app) show in
the preview's **Console** next to the page's own, tagged *server*, and count on
the pill. That includes errors logged while rendering the page, before its
scripts ran. People who open a share link don't see them.

### For agents

```sh
bivy app requests                       # the requests and their last answers (JSON)
bivy app requests --run "Create order"  # run one now; prints its answer and what changed
bivy app requests --all                 # run the ones that run on their own
bivy app data [--run]                   # each query's rows, and changes since the run began
bivy app logs [--since 2m] [--errors]   # the log, with action markers
```

The agent sees what the person sees. When it changes backend behaviour, it adds
a request and a query that show the change and checks them before it says it's
done.

## Automatic web preview delivery

On a linked machine, `bivy app publish` is sufficient: open the published app
from chat or the session menu. **Users and agents do not configure a preview
domain, DNS, certificates, ports, or tunnels.** The authenticated relay advertises
its preview endpoint and the node automatically connects outbound when a browser
requests a preview. The app gateway runs on private in-process streams, without
binding a network port. Static assets, forms, uploads, cookies and WebSocket/HMR
traffic follow the same path; generated applications need no Bivy adapter.

Disconnecting the machine closes active tunnels. On reconnection, delivery
recovers automatically; unexpired grants survive ordinary reconnects to the same
relay endpoint. Restarting the node still requires republishing ephemeral apps.
Older deployments without preview delivery report it unavailable; publishing
must not be described as a working preview until the deployment supports it.

### Bivy deployment responsibility (not user setup)

The deployment operator provisions one isolated wildcard HTTPS preview domain
per relay shard and routes it to that relay's existing HTTP/WebSocket listener:

```sh
RELAY_PREVIEW_ORIGIN='https://{app}.preview.example.net'
```

Preserve Host and WebSocket upgrade headers at the TLS proxy. Use a dedicated
registrable domain, separate from the Bivy UI and other authenticated services.
Each view and its trusted shell get distinct origins beneath that wildcard.
The relay derives a stable node-specific hostname suffix from the admitted node
identity; nodes cannot register or claim another node's hostname family.
No per-node DNS, certificate or ingress is required. The hosted Bivy deployment
must ship this infrastructure alongside the feature, rather than asking users
or agents to provide it. For a self-hosted deployment this is a single platform
installation step, not an app-publishing step.

Preview bytes use separate, bounded outbound WebSocket streams, not encrypted
session-frame payloads. Single-use ten-second stream tickets are delivered only
to the authenticated node and presented in request headers, never URLs. Streams
can reach only that node's app gateway, not arbitrary TCP addresses. Limits are
64 simultaneous pending/active streams per node and 1,024 per relay; stream
frames are limited to 64 KiB with bidirectional backpressure. Disconnection
cancels pending requests and active streams. Browser access remains protected
by the gateway's view-scoped grants, cookies and origin checks below.

Streams are kept alive between requests: a view's `GET`/`HEAD` requests reuse
an idle stream to that view (closed after 4 seconds idle), so a page with
hundreds of modules costs a handful of streams, not one each. Requests with a
body and WebSocket upgrades get their own stream. The relay's `/metrics` counts
preview requests, streams opened, streams open now, capacity refusals and bytes
in each direction (`bivy_relay_preview_*`).

App content may be cached by the viewer's browser, never by a shared cache,
and is always revalidated: the gateway sends `private, no-cache` whatever the
app's own `Cache-Control` says (an app's `no-store` stays `no-store`), so a
preview never shows a stale copy. The app's `ETag`/`Last-Modified` pass
through, so unchanged files come back as small 304s. Static snapshots and the
desktop viewer's modules carry an `ETag` of their own, and text-like files are
sent gzipped. Revalidation still passes the grant check, so revoked access
can't reuse the cache.

### Optional direct gateway

Advanced/local-only deployments may bypass automatic relay delivery and expose
a dedicated gateway through their own TLS proxy or VPN. This is an explicit
operator override, **not required on linked user machines**. Configure the node
process (choose a port different from its API port):

```sh
BIVY_APPS_ORIGIN='https://{app}.preview.example.net'
BIVY_APPS_PORT=4318
# Only for a Bivy client origin different from the node's linked control plane:
# BIVY_APPS_RETURN_ORIGINS='https://my-bivy.example.org,http://localhost:5173'
```

`{app}` is replaced with a random **view** ID for app content and `view-<id>`
for the trusted preview shell. Both are covered by the same wildcard DNS and TLS
certificate. Each app view has its own origin, host-only preview cookie and storage;
its generated code cannot read or overwrite the cross-origin shell. Set up wildcard DNS and a wildcard TLS
certificate for `*.preview.example.net`; reverse-proxy that host family to
`127.0.0.1:4318` on the node. Preserve the original `Host` and WebSocket upgrade
headers. The gateway binds **only to loopback** and is disabled without
`BIVY_APPS_ORIGIN`. A TLS proxy must run on the same machine or securely reach
that loopback listener. Every node needs its own preview hostname family.

For example, the relevant Nginx configuration (provide your own certificate):

```nginx
# In the http block:
map $http_upgrade $preview_connection {
  default upgrade;
  '' close;
}

server {
  listen 443 ssl;
  server_name *.preview.example.net;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4318;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $preview_connection;
    proxy_read_timeout 3600s;
  }
}
```

**Use a dedicated registrable domain, separate from Bivy's UI, control plane and
other authenticated services.** Do not serve generated content on Bivy's origin,
and do not configure preview hosts as trusted node API origins. Sharing a parent
domain with an authenticated service can expose domain-scoped cookies. Bivy does
not provision DNS or certificates for this optional direct-gateway mode.

A paired client requests a one-use, one-minute launch grant through the normal
Bivy command channel. The grant is carried in a URL fragment (not access logs),
exchanged on the dedicated preview origin for a host-only Secure/HttpOnly cookie,
and removed from browser history before app content loads. The shell stores only
non-secret navigation metadata, never tickets or cookies. Its return-to-chat URL
comes from the authenticated client and must point to that session on the node's
linked client/control-plane origin (or an explicitly configured
`BIVY_APPS_RETURN_ORIGINS` origin), over HTTPS or loopback HTTP for development.
Arbitrary external return destinations are rejected. The cookie expires
after one hour and is stripped before forwarding to the app. Grants are scoped
to one view. Removing an app revokes grants and closes active gateway connections.
Reopen from Bivy after expiry. Launch links are bearer capabilities until redeemed;
do not share them.

**Copy address** in the Apps sheet gives a web view's stable address, e.g.
`https://<view>.preview.example.net/`. The address grants nothing by itself, so
it is safe to put on a home screen. A visit without access is sent to the Bivy
client (`/sessions/<id>?node=<node>#preview=…`). There you sign in if needed, and
the client opens that session on its machine. It then asks the node for a
one-use direct link and returns to the same page of the app. So the address
works on devices signed in to the account that owns the machine, and nowhere
else. Addresses stay the same across node restarts, because apps keep their IDs.

**Copy link** in the Apps sheet mints a separate, reusable link for one web view.
It opens the isolated preview shell in reviewer mode, with the app in its own
frame. Every visit exchanges it for a host-only app cookie, capped so a browser
session never outlives the link.
The Share sheet picks how long it works (1 hour, 1 day or 7 days; the choice is
remembered per device) and whether it carries the **Feedback tools** (marking
and notes; on by default). Off, people see only the app: the shell shows no
Bivy controls, the reviewer inspector isn't served, and notes are refused.
It stays valid for that long, until **Stop sharing**, until the app is removed,
or until the machine restarts (links live in the node's memory). While links
are live, the sheet shows how many and when the last one lapses. **Stop
sharing** ends every copied link and the browser sessions and connections opened
from them; your own previews keep working. **Revoke all access** (in the sheet's
⋯ menu) also ends your own open previews, without removing the app. A copied link is a
bearer capability: anyone holding it can use the app, including a live server's
backend, until it lapses or is revoked. Agents mint the same link with
[`bivy app share`](#share-links-bivy-app-share).

**Reviewer notes.** A copied link offers the same **Mark** gesture as the
owner's preview. The visitor marks the page,
writes a note, and chooses **Send note**. No microphone or voice transcription
is available, and submitting feedback never starts an agent run.

When the owner's screenshot setting is on, Bivy retakes the page on the machine
and overlays the marks. The picture is **approximate**: browser state such as
logins, menus and typed input may differ. When screenshots are off, the words
and mark details are saved without a picture. Public capture requests are
bounded and throttled; screenshot bytes and attachment hashes are never returned
to the public browser. A capture failure keeps the draft available to retry.

The owner sees notes under the view in **Apps**, with **View approximate picture**,
**Add to message** (drafts the words and pictures into the composer), and **Clear**.
Notes are untrusted input: at most 1,000 characters each, 50 per view (oldest
dropped), same-origin POSTs from a valid preview session only. Annotation capture
also requires a shared-link session. Notes, bounded mark context, and picture
references are saved with the app (`apps.json`, mode 0600); pictures live in the
attachment store and remain available across restarts. Clearing or dropping a
note releases its picture for normal attachment garbage collection unless it is
referenced elsewhere. Older direct links retain the text-only **Leave a note**
control. Notes reach the agent only if the owner
sends them, or allows the agent to read them (see [Reviewer notes for
agents](#reviewer-notes-for-agents-bivy-app-notes)).

How the owner hears about them:

- **A notification.** Notes arriving close together on one view make one push,
  "2 notes on Storefront", that opens **Apps** at that app. Like every Bivy
  notification it carries IDs, a count and names, never the note text; on
  iPhone the alert is the generic "Session update". Turn it off under
  **Settings → Notifications → Reviewer notes**.
- **At the end of the next run.** Notes that arrived since the last hand-over
  are counted on that view's review card for the run, or on a card of their own
  ("Reviewer notes") when there's nothing else to show. The card has **Add to
  message**, which drafts them, and **Open in Apps**. The card holds a count,
  not the notes: nothing is sent until the owner sends the draft. Preview cards
  **Off** and **Mute for this run** keep these cards away too; the notes wait in
  **Apps**.

The app iframe is sandboxed: scripts, forms, same-origin app storage, downloads
and sandboxed popups are allowed; top-level navigation is not. Upstream
`X-Frame-Options` and CSP `frame-ancestors` are replaced with a policy allowing
only that view's shell; other CSP directives are preserved. If an app depends on
escaping its frame or unsandboxed OAuth popups, it needs its normal development
URL outside this preview mode. The controls remain available even when app access
expires. Reload reloads the page the app is on.

### Preview controls

The preview shell floats one pill over the app, so the app keeps the whole
screen. The pill holds only what must always be visible — which preview you are
in, whether a newer version is waiting, and how many errors the page is logging
— and **⌄** opens a menu with everything else: **Mark something**, **Console**,
**Compare**, the width choices on wide screens, **Reload**, **Move to
top/bottom**, and **Hide controls**, which collapses the pill to a small
**Bivy** button when it covers the app's own bottom bar.

- **Show new version**: appears when an agent turn has built something newer
  than what is on screen. A turn never reloads the preview under you — a scroll
  position, a filled-in form or an open menu would go with it — so the new
  version waits for this tap, and taking it puts you back on the same page at
  the same place.
- **Mark**: pointing at an element and circling an area are one gesture, because
  they are one intention.

  | What you do | What happens |
  | --- | --- |
  | Tap the app | reaches the app, unchanged |
  | Long press, lift without moving | marks that element and opens the note |
  | Long press, then drag | draws a lasso, and marking stays open for more |
  | **Mark**, or the `C` key | opens marking with nothing marked yet |

  In marking, the app freezes under a layer — nothing you draw reaches it — a
  drag draws the path it takes, and a tap marks the element under it. **Undo**,
  **Clear**, **✕**, **Done**. Two fingers (or a mouse wheel) scroll the page,
  and marks stay on the content. Done opens the note box: its context names the
  elements your marks cover (by their content, so circling "Total $102" names
  that line, not the whole row), the page and viewport, and each mark's bounds.
- **One mark, one note, one number.** **Mark another** keeps what you have
  written and hands the layer back, so "the button is too small" and "the total
  is misaligned" stay separate thoughts instead of one lump. Each saved mark
  stays on the page wearing its number, **Undo** walks back through the current
  mark's strokes and then through the notes before it, and the picture carries
  the same numbers, so a note and the thing it is about stay paired. **Add N
  notes to chat** sends them together, as one message and one picture — and each
  note becomes a [pin](#pins) of its own, so they are answered one at a time. A
  reviewer on a shared link sends one note at a time.
- **Add to chat** puts your words and that context in the composer with a
  picture of what you marked, as an ordinary image attachment you can open or
  remove. A long press inside a field, or over text you are selecting, is left
  to the app — a long press already means something there. **Hide controls**
  gives it back entirely, for an app with its own long press (a canvas, a map);
  showing them arms it again.
- **Speaking a note** (in the preview drawer inside Bivy): the note box has a
  mic. Hold it and speak, then let go; or tap to start and tap again to stop. A
  long press that lifts where it landed opens the note already listening. What
  you said goes first in the note, and stays editable, followed by the marks'
  context. Bivy does the listening, not the preview: the shell asks the Bivy page
  that frames it to listen, and only the transcript comes back. Audio goes to the
  node for transcription over the encrypted session channel (Settings → Voice
  input), or to the browser's own dictation when no key is set. It never passes
  through the preview origin. A preview opened in a tab has no mic; use the
  composer's.
  - The picture is made on the machine and fetched by the Bivy page over the
    encrypted session channel: for a web page, the local Chrome retakes it at
    your viewport, pixel ratio and scroll, and the marks are drawn on top. It
    is labelled **approximate** when the page may hold state a fresh browser
    doesn't (storage, cookies, typed input, an open menu or dialog, anything
    you did since the page loaded) or couldn't scroll to where you were; the
    marks and elements are exact either way. A desktop app's picture is its
    current frame, and **Draw on "now"** in Compare marks that screenshot
    itself, so both are exact.
  - Needs agent screenshots for the picture. With them off, you choose: turn
    them on, or add your words, marks and elements without a picture.
  - Strokes, elements and pictures never go through the preview origin: the
    shell hands them to the Bivy page by `postMessage`. The marks use the
    `--annotate` design token, the same colour in both themes.
- **Console** (in the menu): errors and warnings from the page, with the count on the pill.
  Because it is on the pill, the number is visible without opening the menu.
  **Send to agent…** drafts them the same way.
- **Full / Tablet / Phone** (in the menu, wide screens only): constrains the app to 768 or 390 px.
  A phone is already the width it is, so the choice isn't offered there.
- **Compare** (in the menu, with agent screenshots on): before/after screenshots at phone
  width around the agent's last change (review cards reuse these shots), with a handle to reveal either. Bivy
  takes a baseline the first time a view is opened, and one after each turn that
  changes files, of the page last viewed. The last four are kept in memory.

**Sharing into a session.** In the installed app (Android and desktop Chrome),
Bivy is in the system share sheet for text, links and images. A shared
screenshot waits on the device (the service worker keeps it in Cache Storage;
nothing is uploaded) while you pick a session. Sessions with an app preview
show it, and the last page viewed. Picking one opens it with the image as an
ordinary composer attachment and a draft line naming the preview — "Shared a
screenshot — compare it with the Storefront preview (/checkout)." — which you
edit or replace. Nothing is sent until you send it. (iOS: the "Send to Bivy"
Shortcut shares text; a native share extension is separate work.)

These work through a small inspector script that the gateway adds to the app's
HTML page loads, served from the app's own origin (`/__bivy/inspector.js`). The
gateway requests uncompressed HTML for page loads, and adds that exact script URL
to the app's `script-src` (or `default-src`) CSP directive; other directives are
unchanged. A CSP delivered in a `<meta>` tag, `'strict-dynamic'`, or HTML over
5 MiB leaves the inspector out; the preview still works without it. The
inspector only reports to the framing shell. Everything it reports is untrusted
app data, and becomes a draft you review — never a message sent for you.

Preview data uses HTTPS to the deployment's preview ingress and, in automatic
mode, a separate outbound WebSocket tunnel to the node, **not Bivy session E2E
encryption**. The preview ingress/relay operator can see preview traffic. The
existing encrypted chat, terminal and pairing frame transport is unchanged. Generated
service workers are disabled to prevent an offline worker from bypassing the
preview gate; PWA/offline behavior must be tested outside this preview mode.

## Runtime and security boundaries

- Terminal programs use the existing node PTY runtime and the machine user's
  permissions/environment. **This is not a new process sandbox.** Only run code
  you trust; use a dedicated runner for untrusted projects. Bivy doesn't project
  model-vault credentials into app terminals, but the user's inherited environment
  and filesystem can still contain credentials.
- A desktop view's display is an Xvnc server with no network port: its VNC
  socket is a private file (mode 0600) only the node reads, and X clients need
  a per-display cookie that only the view's program is given. It is still not
  a sandbox: the program runs as the node user, like a terminal view.
- A web service is a program you or the agent already started. Registering it
  grants preview access, not ownership of the process. Removing its app does not
  kill that external server. Check port ownership: a service that later reuses
  the same port would be reachable through the registration. Remove stale apps.
- Generated apps do not receive Bivy's device token or preview cookie. Their own
  APIs, credentials and mutations remain their responsibility. No API credential
  broker or transaction-approval layer is implemented by this preview feature.
- Apps persist across node restarts with the same IDs, so chat launchers and
  preview addresses keep working. The data is in `apps.json` in the node's data
  directory, mode 0600. Static views are re-snapshotted, and terminal views and
  managed services come back. **Service views without `start` are not
  restored**: after a restart their port could belong to any process. Detection
  offers them again, one tap to preview. Access grants never persist. After a
  restart, open the preview again from Bivy.
- Share links (**Copy link**, `bivy app share`) are bearer capabilities, not
  identities: anyone who has one can use the app and its live backend until it
  expires (24 h), is revoked, the app is removed or the machine restarts. An agent
  can mint one without asking, so instruct it where it may post links.
- Reviewer notes are untrusted text from anyone with a share link. They reach an
  agent only when the owner sends them or turns on **Agents can read notes** for
  that app. Push notifications and review cards carry a count, never the text.
- Removing an app stops terminal processes started through its views, not unrelated
  terminals. It cannot retract bytes already downloaded or undo side effects.

## Extending the architecture

- `packages/core/src/apps.ts`: versioned manifest and typed view/result contracts.
- `src/apps/registry.ts`: validated, session-scoped app metadata and snapshots;
  publication is atomic and does not start programs.
- `src/apps/service.ts`: composes view providers and owns terminal start/reconnect
  lifecycle. Terminal execution is injected, rather than coupled to a framework.
- `src/apps/gateway.ts`: optional web-only origin, access grants and HTTP/WebSocket
  transport. It knows nothing about agent runtimes or terminals.
- `src/controllers/app-commands.ts`: one command implementation for direct HTTP
  and relay control. The CLI uses these same endpoints.
- `AppMessage.tsx`: durable, ID-based chat launcher; the event log and live
  transcript reducer carry references, never access grants.
- `src/apps/review.ts` and `ReviewCard.tsx`: review cards. When a card is made
  is a table of modes (`REVIEW_MODES`); the service tracks runs and reuses
  Compare's shots; the server stores screenshots as attachments and logs the
  card (`app-review`), which updates in place by ID.
- `src/apps/display.ts`, `x11.ts`, `rfb.ts`, `display-viewer.ts`: desktop
  views — a private Xvnc display per view, a minimal window manager that fits
  windows to the viewer, VNC capture for screenshots, and the noVNC viewer the
  gateway serves. The gateway only relays the viewer's WebSocket to the
  display's socket; it knows nothing about X.
- `src/apps/preview-shell.ts`: trusted preview controls on a separate origin from
  generated content. It uses the canonical styles and design tokens, also copied
  into standalone node releases.
- `AppsSheet.tsx`: app discovery and view selection; terminal views delegate to
  the existing `TerminalOverlay` instead of duplicating a terminal renderer.

A new view kind needs a validated descriptor, an execution/transport provider,
and a client renderer. Unsupported kinds fail closed. Another display provider
(e.g. macOS window capture for native Mac and iOS Simulator apps) would supply
the same thing the Linux one does: a VNC-speaking socket per view, plus the
program's environment. Automatic HTTP tunneling, persistent
app deployments, embedded web panels, managed service launch/restart/logs and API
broker capabilities are separate additions, not implied by the current contract.
