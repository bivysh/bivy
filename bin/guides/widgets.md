# Put something interactive in your reply

Summary: Widgets: small HTML pages that run inside your chat message — forms, pickers, checklists, live views — and can answer you.

A widget is a web page you write that runs inside your message, sandboxed, with
the app's look already applied. Use one when the user should *do* something
(pick, fill in, tick off, compare, adjust) rather than read: it beats asking
them to type an answer.

## Start one

    bivy widget init widgets/pick.html

writes a working starter (a question with buttons). Edit it, then show it in your
reply on its own line:

    ::view{src=widgets/pick.html}

To give it data, use a fence instead and read `bivy.data` in the page:

    ```bivy
    {"type":"widget","url":"widgets/pick.html","data":{"question":"Which plan?","options":["A","B"]},"title":"Plan"}
    ```

A small one can be inline, with no file: `{"type":"widget","html":"<button …>"}`.
One a plugin provides is placed by name: `{"type":"widget","widget":"standup","data":{…}}`
(`bivy widget list` shows them). To make a widget the user can reuse in every
session, put it in a plugin: `bivy guide extend-bivy`.

## What the page can use

    bivy.ready(fn)       run fn once data, theme and saved state are in
    bivy.data            what you placed it with
    bivy.state           what it saved; bivy.setState(obj) saves it
    bivy.send(text)      reply to you as the user
    bivy.openLink(url)   open a page in a new tab
    bivy.expand()        full screen; bivy.collapse() to return
    bivy.call(name, args) a plugin tool offered to widgets (`bivy tools list`)

- Put the content in the widget itself — swatches for colours, a preview for
  layouts, the numbers on a slider — and do not repeat it as a list around it.
  The starter is text buttons; change it to show what is being chosen.
- `bivy.send` works only from a click or key press in the widget. Send a short,
  readable sentence ("I pick: B"), because it shows in the chat as theirs.
- Save choices with `bivy.setState` (or `localStorage`, which is saved the same
  way) so the widget shows them after a reload and on their other devices.
  Disable what was already answered.
- `bivy widget state` shows you what every widget in this session saved. Read it
  when the user says they filled something in.

## Make it look right

Plain `button`, `input`, `select`, `table` and headings are already styled like
the app, in light and dark. Use `class="primary"` for the main button, and the
app's tokens for anything custom: `var(--accent)`, `var(--muted)`, `var(--line)`,
`var(--surface-2)`, `var(--space-2)`, `var(--radius-md)`. Never hardcode colours:
the user may be in dark mode. Keep it compact; it sits in a chat column, often on
a phone 390px wide. The frame grows to fit its content.

## Limits

- One self-contained page up to 2 MB. Scripts, styles, fonts and images from
  `https://` (a CDN) load; `fetch`, XHR and WebSockets do not. For live data,
  use a plugin tool through `bivy.call`, or put the data in `data`.
- It cannot reach the app, its storage or other messages. It runs again each
  time the message is shown, so do not send from a load handler.
- The page is captured when your message ends: edit the file and show it again
  in a new message to update it.

The protocol is MCP Apps (JSON-RPC over postMessage), so a view built for
another MCP Apps host runs here too.
