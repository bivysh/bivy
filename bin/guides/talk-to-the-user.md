# Talk to the user

Summary: When to answer in chat, when to notify, and when to ask and wait.

Your chat reply is the default. Reach for these when the chat alone won't do.

## They may be away: notify

    bivy notify
    bivy notify --urgent

Pushes to their devices so they come back to this session. The push names the
session only and nothing is posted in the chat, so say what you need in your
reply. It goes out only when nobody has the app open; `--urgent` pushes even
while they are looking. One push a minute per session.

You don't need it when you finish: Bivy already pushes when a turn ends while
they are away. Use it while you keep working and need them, for example when a
long run is blocked on something only they can do.

Next steps and options go in your reply as plain text.

## You need a decision: ask

    bivy ask "Which database?" --option Postgres --option SQLite
    bivy ask "What should the release be called?"

Blocks until they answer and prints the answer (exit 0). Exit 1 means they
dismissed it (use your judgment), exit 5 that `--timeout` (default 10m) passed.
For long waits use `--async`, keep working, and later `bivy ask wait <id>`.
Ask only when you can't reasonably decide yourself.

## Name the session: title

    bivy title "Fix login redirect loop"

The session list shows a title taken from the first message. When that doesn't
say what the work is, or the work changes direction, rename it. Keep it short.

## Is anyone there?

`bivy context --json` reports `userConnected` (some device has the app open) and
`lastDriver` (the device that last typed into this session).
