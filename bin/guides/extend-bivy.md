# Extend Bivy for the user

Summary: Plugins: give the user a new widget, tool, theme, guide or agent on their machine, built and installed by you in minutes.

When the user wants Bivy itself to do more — "show my standup as a checklist
every morning", "a dark theme like my editor", "let widgets check CI", "add the
agent we use at work" — build a plugin. You write it, install it on this
machine, and it works at once. Nobody has to send a pull request or wait for a
release; the user never writes code.

## Start from a working one

    bivy plugin init ~/bivy-plugins/standup --kind widget   # or tool, theme, guide, agent
    bivy plugin dev ~/bivy-plugins/standup                  # install, then reinstall on every change

Keep plugins in their own folder outside the project (`~/bivy-plugins/<id>`),
since install copies the whole folder. `bivy plugin dev` runs until stopped: run
it in the background, or use `bivy plugin install <folder> --force` after each
change.

## What a plugin can add

All in one `bivy.plugin.yaml`; a plugin may add several kinds.

**Widgets** — a page placed by name, so any session can use it:

    contributes:
      widgets:
        - { id: standup, name: Standup, entry: widgets/standup.html }

Place it with a fence: ```` ```bivy {"type":"widget","widget":"standup","data":{…}} ``` ````.
Write the page like any widget (`bivy guide widgets`). `bivy widget list` shows
installed ones.

**Tools** — a command with JSON in (stdin) and JSON out (stdout), callable by
any agent (`bivy tools run`, and as an MCP tool) and, with `widgets: true`, by a
widget (`bivy.call("ci_status", {…})`) for live data:

    contributes:
      tools:
        - name: ci_status
          description: Latest CI result for a branch. Use before saying CI is green.
          input: { branch: { type: string, required: true } }
          command: node
          args: ["{plugin}/tools/ci.mjs"]
          widgets: true

It runs in the session's workspace with `BIVY_SESSION_ID` set; `{plugin}` is the
installed plugin's folder. Exit non-zero to report an error. 30 s by default
(`timeoutSeconds`, up to 300).

**Themes** — the app's palette: `bivy theme set <id>` after install.

    contributes:
      themes:
        - id: dusk
          name: Dusk
          mode: dark
          colors: { background: "#101018", foreground: "#e0e0f0", accent: "#88aaff" }

Colors: background, foreground (required), accent, selection, muted, red,
green, yellow, blue, magenta, cyan, orange.

**Guides** — a playbook agents read with `bivy guide <topic>`: how this user
likes things done, a team's conventions, how to use the plugin's tools.

    contributes:
      guides:
        - { topic: standups, file: guides/standups.md }

The file needs a `# Title` line and a `Summary: …` line.

**Agents** — any CLI or ACP agent: `bivy guide add-an-agent`.

## Check, then tell the user

    bivy plugin validate <folder>      # the manifest
    bivy plugin list                   # installed, and any conflicts
    bivy tools run <name> key=value    # try a tool
    bivy guide <topic>                 # read a guide back

Then show the result: place the widget in your reply, or say which theme is
set. To share a plugin, push its folder to a git repository; anyone installs it
with `bivy plugin install github:owner/repo[/path]`.
