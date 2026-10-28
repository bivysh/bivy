# Chat widgets

A widget is a small web page an agent puts **inside its chat message**: a form,
a picker, a checklist, a slider that tunes a value, a live view of something on
the machine. It runs in the chat, styled like the rest of the app, and can
answer the agent. Any agent that can write a file can make one: it is plain
HTML, and placing it is a line of markdown.

```text
Here are the three layouts. Pick one and I'll build it:

::view{src=widgets/layouts.html}
```

## Placing a widget

| Form | Use |
|---|---|
| `::view{src=widgets/x.html}` | A page in the session workspace. Any `.html` file shown this way runs as a widget. |
| ` ```bivy {"type":"widget","url":"widgets/x.html","data":{…}} ``` ` | The same page, handed data (`bivy.data`). `title`, `caption`, `height` and `id` are optional. |
| ` ```bivy {"type":"widget","html":"<button>…</button>"} ``` ` | A small page inline, with no file (16 KB). |
| ` ```bivy {"type":"widget","widget":"standup","data":{…}} ``` ` | A widget a [plugin](plugins.md) on the machine provides, by name (`bivy widget list`). |

Agents check a widget before placing it with `bivy widget shot <file>` (MCP
tool `widget_shot`): it renders the page in the same frame and runtime, light
and dark, at phone and desktop width, and returns the screenshots and every
error the page raised. In the chat, a widget that raises an error says so under
it instead of failing silently.

The page is captured when the message is written, the same way an image is,
so the message shows the same widget on every device and after the file
changes. Agents start one with `bivy widget init <file>`, and `bivy guide
widgets` is the playbook they read.

## What a widget can do

The frame writes a small runtime into every widget, `window.bivy`:

| API | |
|---|---|
| `bivy.ready(fn)` | Runs `fn` once the widget has its data, theme and saved state. |
| `bivy.data` | The `data` the agent placed it with. |
| `bivy.state`, `bivy.setState(obj)` | State saved on the session's machine, the same on every device. |
| `localStorage` | Works, and is saved with the widget's state. |
| `bivy.send(text)` | Sends `text` to the agent as the user's next message. |
| `bivy.openLink(url)` | Opens an `http(s)` page in a new tab. |
| `bivy.expand()` / `bivy.collapse()` | Full screen and back, without reloading. |
| `bivy.call(name, args)` | Calls a [plugin tool](plugins.md#tools) offered to widgets (`widgets: true`); resolves to its JSON answer. |

The agent reads what widgets saved with `bivy widget state` (MCP tool
`widget_state`).

Plain elements (`button`, `input`, `select`, `table`, headings) are styled like
the app, in light and dark, at zero specificity so the widget's own CSS wins.
The app's design tokens are set on the widget's root under their own names
(`--accent`, `--surface-2`, `--space-2`, …) and under the MCP Apps standard names
(`--color-background-primary`, …), and they update when the theme changes.

## Security model

A widget is agent-written code, and an agent's output can be shaped by what it
reads. The widget therefore runs with nothing of the app's:

- **Opaque origin.** The frame is always framed with the `sandbox` attribute,
  without `allow-same-origin`, and servers also send the `sandbox` directive as
  a header. The widget cannot read the app's storage, cookies, DOM or API, and
  cannot navigate the app.
- **No network calls.** The frame page carries its own Content-Security-Policy
  (a meta tag, so it holds whichever server hands the page out, and markup
  written after it cannot loosen it): `connect-src 'none'`, so no `fetch`, XHR,
  WebSocket or form submission. Scripts, styles, fonts and images may load from
  `https://` CDNs. Live data comes through `bivy.call`, which runs on the machine.
- **The person causes every message.** `bivy.send` is refused unless the frame
  has focus (the person clicked or typed in it), the widget's session is the one
  open, and the last message from that widget was more than a second ago.
- **Bounded state.** 64 KB per widget, 100 widgets per session, stored as JSON
  on the machine (`<data-dir>/widget-state`).
- **Effects are the host's.** Each request is a row in
  `packages/web/src/widgets/host.ts`; anything not in that table is refused.

## Protocol

Widgets speak [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
(spec `2026-01-26`): JSON-RPC 2.0 over `postMessage`, through the same
sandbox-proxy handshake. A view written for another MCP Apps host runs in Bivy,
and a Bivy widget that uses the standard methods runs there.

| Method | Direction | In Bivy |
|---|---|---|
| `ui/initialize` | widget → host | Theme, tokens, locale, display mode; `hostContext.bivy` carries `data` and `state`. |
| `ui/notifications/tool-input`, `tool-result` | host → widget | The placement's `data`, once, after `initialized`. |
| `ui/message` | widget → host | Sends a user message, under the rules above. |
| `ui/open-link` | widget → host | New tab, `http(s)` only. |
| `ui/request-display-mode` | widget → host | `inline` or `fullscreen`. |
| `ui/update-model-context` | widget → host | Saved with the widget's state as `modelContext`. |
| `ui/notifications/size-changed` | widget → host | The inline frame grows to fit, up to 720px. |
| `ui/notifications/host-context-changed` | host → widget | Theme or display mode changed. |
| `tools/call` | widget → host | A plugin tool on the session's machine. |
| `bivy/state/set` | widget → host | Bivy extension: save the widget's state. |

## Limits

- A page is at most 2 MB, and one message holds at most six components.
- A widget runs again each time its message is shown; do not send from a load
  handler (it is refused anyway).
- The inline frame is at most 720px tall; longer content scrolls or goes full
  screen.
