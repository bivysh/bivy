# Plugins

A plugin makes Bivy do more on your machine: a **chat widget** any session can
place, a **tool** agents and widgets can call, a **theme** for the app, a
**guide** agents read, or another **agent**. It is a folder with a
`bivy.plugin.yaml`.

You do not have to write it. Ask the agent in any session — "add a standup
checklist I can tick off every morning", "make the app look like my editor",
"let widgets show CI status" — and it builds the plugin, installs it on this
machine and shows you the result (`bivy guide extend-bivy` is the playbook it
follows). Nothing goes through a pull request or a release.

The API is alpha (`bivy.sh/v1alpha1`): fields may still change before a stable v1.
A manifest never runs code inside the node. Widgets run sandboxed in the chat,
tools and agents run as separate processes, and themes and guides are data.

| Kind | What it adds | Used with |
|---|---|---|
| `widgets` | An HTML page placed in a message by name | ```` ```bivy {"type":"widget","widget":"<id>"} ``` ````, `bivy widget list` |
| `tools` | A command, JSON in and out | `bivy tools run`, MCP (every agent), `bivy.call` in widgets |
| `themes` | A palette for the app | `bivy theme set <id>` |
| `guides` | A markdown playbook | `bivy guide <topic>` (and MCP resources) |
| `agents` | An ACP or CLI agent | the agent picker; see [Add any agent](add-an-agent.md) |

## Quick start: widget, tool, theme, guide

```bash
bivy plugin init ~/bivy-plugins/standup --kind widget   # or tool, theme, guide, agent
bivy plugin dev ~/bivy-plugins/standup                  # install, then reinstall on every change
```

`init` writes a plugin that already works; `dev` installs it and reinstalls on
every save, and each change takes effect at once. A plugin may combine kinds:

```yaml
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: standup
  name: Standup
  version: 0.1.0
requires:
  bivy: ">=0.21.0 <1.0.0"
contributes:
  widgets:
    - id: standup
      name: Standup
      description: Yesterday, today, blockers — tick off and send.
      entry: widgets/standup.html
  tools:
    - name: ci_status
      description: Latest CI result for a branch. Use before saying CI is green.
      input:
        branch: { type: string, description: Branch name., required: true }
      command: node
      args: ["{plugin}/tools/ci.mjs"]
      widgets: true
  themes:
    - id: dusk
      name: Dusk
      mode: dark
      colors: { background: "#101018", foreground: "#e0e0f0", accent: "#88aaff" }
  guides:
    - topic: standups
      file: guides/standups.md
```

### Widgets

`entry` is an HTML page in the plugin folder, written like any
[chat widget](widgets.md): the `window.bivy` runtime, the app's tokens, the same
sandbox. An agent places it by name and hands it data:

````text
```bivy
{"type":"widget","widget":"standup","data":{"date":"2026-10-28"}}
```
````

A plugin widget is read from the machine each time it is shown, so updating the
plugin updates every message that uses it. Removing the plugin leaves a card
that names the widget.

### Tools

A tool is a command. Bivy starts it as a child process in the session's
workspace, writes the input as JSON on stdin, and reads JSON (or text) from
stdout; a non-zero exit is an error and the last lines of stderr are the
message. `{plugin}` in `command` or `args` is the installed plugin's folder, and
the process gets `BIVY_SESSION_ID`, `BIVY_PLUGIN_ROOT` and `BIVY_TOOL`.

| Field | |
|---|---|
| `name` | `lowercase_with_underscores`, unique across plugins |
| `description` | What it does and when to call it; agents read this |
| `input` | Fields: `{ type: string\|number\|boolean\|array\|object, description, required }`. Input is checked against them; unknown fields are refused. |
| `command`, `args` | What to run |
| `timeoutSeconds` | 1–300, default 30 |
| `widgets` | `true` lets chat widgets call it (`bivy.call`). Off by default: a widget is agent-written code, so a tool is offered to widgets only on purpose. |

Agents call tools with `bivy tools run <name> key=value` or `--input '<json>'`.
Every plugin tool is also served by `bivy mcp-serve`, so it appears in the tool
list of every agent Bivy injects that server into. A plugin cannot shadow
Bivy's own tools.

### Themes

A theme is a palette: `background` and `foreground` (required), and `accent`,
`selection`, `muted`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`,
`orange`, as `#rgb` or `#rrggbb`, plus an optional `mode`. `bivy theme set <id>`
makes it this machine's theme. It replaces a desktop (Omarchy) theme, and every
app showing the **Machine** theme (the default) follows within seconds.
`bivy theme clear` goes back.

### Guides

A guide is markdown with a `# Title` line and a `Summary: …` line. `bivy guide`
lists it with the built-in guides, and `bivy mcp-serve` serves it as a resource.
A plugin cannot replace a built-in topic.

## See and manage them in the app

**Settings → this machine → Plugins** lists every installed plugin and what it
adds. Remove one there, or choose between plugin themes. Installing stays with
agents and the CLI.

## Install from anywhere, share as a repository

```bash
bivy plugin install ./standup                          # a folder (or its manifest)
bivy plugin install github:owner/repo/plugins/standup#v1.2.0
bivy plugin install https://gitlab.com/team/bivy-plugins.git
```

A git source is cloned shallowly into a temporary folder first. Install copies
the plugin's folder into the store: regular files only, no symlinks, no
dot-directories such as `.git`, at most 2000 files and 50 MB. It never runs an
install script or downloads dependencies, so a tool that needs packages ships
them in the folder.

Sharing a plugin is pushing its folder to a repository and giving the
repository the `bivy-plugin` topic. There is no registry to publish to:
`bivy plugin search [words]` finds tagged repositories on GitHub and prints the
install command for each.

### Kits: a whole setup

A kit is several plugins and a theme in one folder, listed in `bivy.kit.yaml`:

```yaml
apiVersion: bivy.sh/v1alpha1
kind: Kit
metadata: { id: my-setup, name: My setup }
plugins: [plugins/standup, plugins/dusk]
theme: dusk
```

`bivy kit export <dir>` writes the plugins installed on this machine (and the
chosen theme) as one; `bivy kit apply github:owner/repo` installs one. Tag a
shared kit's repository `bivy-kit`.

## Terminology and boundaries

These concepts occupy different layers:

- a **plugin** is the versioned distribution unit;
- a **contribution** is a capability declared by a plugin;
- a **connection** is configured credentials/account state;
- a **tool** is a governed callable operation;
- **MCP** is a preferred protocol for discovering and invoking tool/context
  providers, not the package itself;
- a **skill** is procedural context (for example, `SKILL.md`), not executable
  capability and never a permission grant;
- an **agent profile** composes an adapter, model, skills, tools, policy,
  credentials, and compute defaults.

Not every MCP server needs a plugin, not every tool uses MCP, and repository-local
skills do not need to be installed globally. Future tool support will put Bivy's
tool broker between upstream MCP providers and downstream agents so policy,
approvals, and audit remain authoritative. MCP prompts will not silently become
trusted skills.

## One agent registry

Every agent enters the same ordered integration registry, whether its profile is
maintained in the Bivy distribution, configured on the node, or installed as a
plugin package. Every integration owns the same lifecycle hooks: identity and
aliases, provenance, visibility, discovery, catalog description, connection,
and an optional allowlisted upstream installer.

Bivy integrations do not replace or reimplement the upstream agent. They locate
the agent the operator already installed and connect through ACP, an agent-native
protocol, a structured process, or an out-of-process bridge. Pi and Claude Code
follow this rule too: their richer bridges live under `src/agents/`, but launch
and hand sessions to the operator's `pi` and `claude` commands.

Package/configuration order resolves collisions deterministically, with both the
retained and rejected origins reported. Verification is explicit package
provenance and never permission to weaken Bivy's policy floor.

Most maintained integrations are data in `src/agents/profiles.ts`; they do not
need one folder per agent. A folder is reserved for a real bridge or supporting
fixtures, as with `src/agents/pi/`, `src/agents/claude-code/`, and the Codex app-server
integration under `src/agents/codex/`. Probing may
verify command availability, version/help evidence, and protocol handshakes, or
downgrade a declared capability. It never invents launch flags, resume syntax,
sandbox semantics, or privileged behavior from help text.

## Bring your own agent

To run an agent on your own Machine, you don't need a plugin: add it to
`config.yaml` with `bivy agent add` or by hand. See [Add any agent](add-an-agent.md),
which also covers writing an adapter. A plugin packages the same `adapter` block
with a name and version so it can be shared and pinned.

## Quick start: ACP agent

Create `bivy.plugin.yaml`:

```yaml
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: company-agent
  name: Company Agent
  version: 0.1.0
  description: Internal coding agent exposed over ACP.
requires:
  bivy: ">=0.21.0 <1.0.0"
contributes:
  agents:
    - id: company-agent
      name: Company Agent
      description: Governed internal coding agent.
      authOwner: agent
      adapter:
        kind: acp
        command: company-agent
        args: [acp]
```

Then validate, conformance-test, and install it:

```bash
bivy plugin validate ./bivy.plugin.yaml
bivy plugin doctor ./bivy.plugin.yaml
bivy plugin test ./bivy.plugin.yaml
bivy plugin install ./bivy.plugin.yaml
bivy plugin list
```

The agent appears as **Experimental / Unverified** in Bivy's agent picker. ACP
provides streaming, resume, and per-tool approval requests through the same
`ProtocolRuntime` used by other ACP integrations.

The command must already be installed on the node's `PATH`. Plugin installation
never downloads software or runs an install script.

## Process agent

A process adapter launches one headless process per turn and streams its output.
The prompt defaults to stdin; use `promptMode: argv` when the command expects a
trailing prompt argument.

```yaml
apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata:
  id: review-bot
  name: Review Bot
  version: 1.0.0
contributes:
  agents:
    - id: review-bot
      name: Review Bot
      adapter:
        kind: process
        command: review-bot
        args: [run]
        promptMode: argv
        structured:
          args: [run, --output, stream-json]
          parser: generic-stream-json
        resume:
          args: [run, --resume, "{id}"]
          # Optional: use when a fresh launch accepts a caller-assigned id.
          newArgs: [run, --session-id, "{id}"]
        model:
          flag: --model
          insertAt: 1
          choices:
            - id: fast
              name: Fast
              provider: review-bot
            - id: thorough
              name: Thorough
              provider: review-bot
```

Supported parser ids:

- `bivy-protocol`
- `claude-stream-json`
- `codex-json`
- `goose-stream-json`
- `gemini-json`
- `generic-stream-json`
- `generic-json`

Prefer ACP when the agent supports it. A one-shot process can provide text,
structured events, model flags, and native resume, but it cannot ask Bivy for a
pre-execution decision on its built-in tools.

## Manifest reference

Top-level fields are strict; unknown fields fail validation.

```yaml
apiVersion: bivy.sh/v1alpha1 # required, exact
kind: Plugin                # required, exact
metadata:
  id: lowercase-slug        # required, 2-48 characters
  name: Human name          # required
  version: 1.2.3            # required
  description: Optional
  homepage: https://example.com
requires:
  bivy: ">=0.21.0 <1.0.0" # optional semver range; recommended
contributes:                # at least one entry across these
  agents: []                # up to 20
  widgets: []               # up to 20: id, name, description?, entry (.html)
  tools: []                 # up to 50: name, description, input?, command, args?, timeoutSeconds?, widgets?
  themes: []                # up to 20: id, name, mode?, colors
  guides: []                # up to 20: topic, file (.md)
```

Paths (`entry`, `file`) are relative to the plugin folder and may not contain
`..`. Ids, tool names and topics must be unique within a manifest; one that two
installed plugins both claim is used by neither, and `bivy plugin list` says so.

An agent contribution supports:

- `id`, `name`, and optional `description`;
- `hidden: true` to keep it out of the normal picker while retaining explicit
  `BIVY_RUNTIME=<id>` access;
- `authOwner: agent | bivy | mixed`;
- `adapter.kind: process | acp`.

Commands and arguments are bounded during validation. Resume arguments must contain an `{id}` placeholder. Process agents that accept
an id on first launch may also declare `resume.newArgs` with `{id}`; Bivy then
persists that host-assigned ref immediately and uses `resume.args` from the
second turn onward. Otherwise, validated structured parsers capture a native ref
from the agent's output when the format exposes one. Model choices and agent ids must be unique within
the manifest.

## SDK, schema, and developer loop

The repository's publishable `@bivy/plugin-sdk` workspace package contains the
canonical TypeScript manifest types, parser, validator, compatibility check,
executable diagnostics, and JSON Schema. The schema is exported as
`PLUGIN_MANIFEST_SCHEMA` and packaged at `@bivy/plugin-sdk/schema.json` for
editors and non-TypeScript tooling. Public npm publication remains a separate
release step while the alpha contract is exercised in-tree.

Scaffold a manifest and run local diagnostics:

```bash
bivy plugin init ./company-agent --adapter acp
# Edit the generated command and arguments.
bivy plugin validate ./company-agent
bivy plugin doctor ./company-agent
bivy plugin test ./company-agent
```

`doctor` checks `requires.bivy` and resolves every adapter executable without
invoking it. `test` repeats those checks and drives ACP adapters through the real
Bivy bridge; each must complete `initialize` and `session/new` within 15 seconds.
Process adapters receive static conformance only because automatically prompting
an arbitrary command could spend money or mutate a workspace.

A complete runnable plugin is available under
[`../examples/plugins/acp-agent`](../examples/plugins/acp-agent).

## CLI

```bash
bivy plugin init [directory] [--kind agent|widget|tool|theme|guide] [--id <slug>] [--name <name>] [--adapter acp|process] [--json]
bivy plugin validate <file-or-directory> [--json]
bivy plugin doctor <file-or-directory> [--json]
bivy plugin test <file-or-directory> [--json]
bivy plugin install <file-or-directory|git URL|github:owner/repo[/path][#ref]> [--force] [--json]
bivy plugin dev <directory>
bivy plugin list [--json]
bivy plugin remove <plugin-id> [--json]
bivy tools list|run <name> [--input '<json>'] [key=value …] [--json]
bivy theme list|set <id>|clear [--json]
bivy widget list [--json]
```

When a directory is supplied, Bivy looks for `bivy.plugin.yaml`,
`bivy.plugin.yml`, `bivy.plugin.json`, `manifest.yaml`, or `manifest.json`.

Installed manifests are canonicalized into the plugin's copied folder:

```text
<data-dir>/plugins/<plugin-id>/manifest.json
<data-dir>/plugins/<plugin-id>/widgets/…, tools/…, guides/…
```

Writes and replacements are atomic. The node reads the store each time it lists
agents, shows a plugin widget or runs a tool, so an install or removal takes
effect without a restart.
Set `BIVY_PLUGIN_DIR` to override the store location for testing or managed
deployments.

`bivy plugin list` reports malformed installed manifests and duplicate agent ids.
An invalid or incompatible plugin is omitted from the agent catalog and does
not prevent other integration packages from starting. Installation fails when the current
Bivy version does not satisfy a declared `requires.bivy` range. Manifests that
omit the range still install, and `doctor` reports the missing pin as a
warning.

## Trust and protection

A plugin is installed by you, or by an agent working for you, on your own
machine. Treat one from someone else like any other program you install.

- **Widgets** run in the chat's widget sandbox ([security model](widgets.md#security-model)):
  no access to the app, no network calls. They reach tools only when a tool sets
  `widgets: true`.
- **Tools** run as your OS user, in the session's workspace, with the input
  checked against their declared fields, bounded output and a timeout.
- **Themes and guides** are data. A guide is text agents read, never a
  permission.

Installing an agent authorizes Bivy to launch the declared executable with the
session workspace as its working directory. The executable has the permissions
of the selected Bivy execution path:

- ACP tools pass through Bivy's structured approval flow when the agent asks for
  permission correctly.
- Process adapters usually run with the node OS user's permissions unless the
  agent provides its own native sandbox or the node applies an external
  container/VM boundary.
- A plugin cannot weaken node or repository approval/sandbox floors.
- Provider credentials may be projected into an agent process according to its
  `authOwner` and the existing runtime credential rules. Review the executable,
  manifest, and requested model/provider behavior before installation.

There is no central plugin registry or review: a plugin is a folder, shared as
a git repository, and `bivy plugin search` lists what people tagged. Read a
plugin before installing it, install from sources you trust, and pin a tag
(`#v1.2.0`).

## Current limitations and roadmap

`v1alpha1` does not yet support:

- MCP server contributions or OAuth connection forms (a tool can wrap a CLI);
- trigger connectors, checks, artifacts or compute providers;
- install scripts or dependency downloads;
- daemon hooks, or UI outside chat widgets and themes;
- lockfiles, signatures or trust tiers.
