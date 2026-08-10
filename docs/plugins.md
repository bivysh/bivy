# Plugins

Bivy plugins add agents without requiring a Bivy source change. The first plugin
API is deliberately narrow and safe: a plugin is a strict declarative manifest,
and its agent runs out of process through Bivy's existing process or ACP adapter.
Bivy does not import third-party JavaScript into the node.

The API is alpha (`bivy.sh/v1alpha1`). Pin and review manifests like any other
executable tool configuration; fields may evolve before a stable v1.

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

Then validate and install it:

```bash
bivy plugin validate ./bivy.plugin.yaml
bivy plugin install ./bivy.plugin.yaml
bivy plugin list
bivy restart
```

The agent appears as **Experimental / Unverified** in Bivy's agent picker. ACP
provides streaming, resume, and per-tool approval requests through the same
`ProtocolRuntime` used by built-in ACP agents.

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
contributes:
  agents: []                # 1-20 entries in v1alpha1
```

An agent contribution supports:

- `id`, `name`, and optional `description`;
- `hidden: true` to keep it out of the normal picker while retaining explicit
  `BIVY_RUNTIME=<id>` access;
- `authOwner: agent | bivy | mixed`;
- `adapter.kind: process | acp`.

Commands and arguments are bounded during validation. Resume arguments must
contain an `{id}` placeholder. Model choices and agent ids must be unique within
the manifest.

## CLI

```bash
bivy plugin validate <file-or-directory> [--json]
bivy plugin install <file-or-directory> [--force] [--json]
bivy plugin list [--json]
bivy plugin remove <plugin-id> [--json]
```

When a directory is supplied, Bivy looks for `bivy.plugin.yaml`,
`bivy.plugin.yml`, `bivy.plugin.json`, `manifest.yaml`, or `manifest.json`.

Installed manifests are canonicalized into:

```text
<data-dir>/plugins/<plugin-id>/manifest.json
```

Writes and replacements are atomic. Install/remove requires a node restart so
the daemon, service environment, and terminal CLI use the same contribution set.
Set `BIVY_PLUGIN_DIR` to override the store location for testing or managed
deployments.

`bivy plugin list` reports malformed installed manifests and duplicate agent ids.
An invalid plugin is omitted from the runtime catalog and does not prevent
built-in agents from starting.

## Trust and protection

Installing a manifest authorizes Bivy to launch the declared executable with the
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

There is no public plugin registry yet. Distribute manifests and executables
through channels you already trust, pin their versions, and install locally.

## Current limitations and roadmap

`v1alpha1` supports agent contributions only. It does not yet support:

- MCP tool contributions or OAuth connection forms;
- trigger connectors, checks, artifacts, or compute providers;
- plugin install scripts or dependency downloads;
- arbitrary daemon or web UI hooks;
- compatibility ranges, lockfiles, signatures, or marketplace trust tiers.

The staged roadmap is in
[`internal/developer-platform-implementation-plan.md`](internal/developer-platform-implementation-plan.md).
