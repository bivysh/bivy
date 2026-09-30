# Show the user something

Summary: Attach files, publish live previews, check them with screenshots, and present a finished change.

The user reads your session in a chat app, often on a phone. They cannot see your
terminal, your files, or anything you only describe. Put things in front of them.

## A file or image

    bivy attach out/chart.png --caption "Revenue by month"
    bivy attach report.pdf --artifact

Images render inline; other files download. The path must be inside the session
workspace. `--artifact` also lists it in the session's Artifacts, for durable
outputs (reports, coverage, builds). Markdown image syntax with a local path does
not render; a remote `https://` image does.

## Something with a UI

Publish it once; the user opens it from the chat:

    bivy app run -- cargo run                    # a desktop app, no manifest
    bivy app publish app.json                    # web server, static build, terminal

A `terminal` view is a command the user can watch and type into from the app,
such as a REPL or a log tail:

    {"kind":"terminal","name":"Console","command":"bin/rails","args":["console"]}

A manifest with a server Bivy starts on first open:

    {"version":1,"name":"Site","views":[{"kind":"web","name":"Web",
      "source":{"kind":"service","port":5173,"start":{"command":"pnpm","args":["dev"]}}}]}

## Check your work before you say it's done

    bivy app shot --widths 390,1280 --themes light,dark

prints PNG paths. Look at them. Screenshots are off until the user turns them
on (`bivy config set sessions.appScreenshots true`).

## Hand it over

    bivy app present --note "The header now wraps on phones"

posts a card with the app at phone width (before and after) and opens the
preview. Use it when a visible change is ready, not after every edit.

More: `bivy app --help`, `bivy attach --help`.
