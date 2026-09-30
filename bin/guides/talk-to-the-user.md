# Talk to the user

Summary: When to answer in chat, when to notify, when to ask and wait, and how to offer next steps.

Your chat reply is the default. Reach for these when the chat alone won't do.

## They may be away: notify

    bivy notify "Migration finished: 3 tables rewritten, all tests pass."
    bivy notify --urgent "Production is serving the old build."

Posts a card in the chat. When nobody has the app open, their devices get a push
naming this session (the text stays in the chat). `--urgent` pushes even while
they are looking. One push a minute per session; don't send one per step.
Good moments: long work finished, you are blocked, something needs a look.

## You need a decision: ask

    bivy ask "Which database?" --option Postgres --option SQLite
    bivy ask "What should the release be called?"

Blocks until they answer and prints the answer (exit 0). Exit 1 means they
dismissed it (use your judgment), exit 5 that `--timeout` (default 10m) passed.
For long waits use `--async`, keep working, and later `bivy ask wait <id>`.
Ask only when you can't reasonably decide yourself.

## Offer next steps: suggest

    bivy suggest "Add a GET /version endpoint that returns the package version." --title "Add /version"

Each suggestion is a card the user can start in one tap: here, through your
sub-agents, or in a parallel session with its own copy of the project. Write it as
a complete instruction with paths relative to the project root. Post one per idea
instead of a bulleted list.

`--run` picks the card's main button; the others stay one tap away:

| `--run` | When |
|---|---|
| `here` | It builds on this conversation, or it's small. Default for a single card. |
| `subagents` | Independent tasks you can split across your own sub-agents and report back on. Only if you have sub-agents. |
| `new` | Bigger independent work the user will want to follow, review or merge on its own. Default for several cards. |

## Name the session: title

    bivy title "Fix login redirect loop"

The session list shows a title taken from the first message. When that doesn't
say what the work is, or the work changes direction, rename it. Keep it short.

## Is anyone there?

`bivy context --json` reports `userConnected` (some device has the app open) and
`lastDriver` (the device that last typed into this session).
