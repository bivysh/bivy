# Plugins

Bivy plugins add agents without requiring a Bivy source change. The first plugin
API is deliberately narrow and safe: a plugin is a strict declarative manifest,
and its agent runs out of process through Bivy's existing process or ACP adapter.
Bivy does not import third-party JavaScript into the node.

The API is alpha (`bivy.sh/v1alpha1`). Pin and review manifests like any other
executable tool configuration; fields may evolve before a stable v1.

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

An ACP agent needs only a command and, when applicable, its ACP arguments:

```bash
bivy agent add company-agent \
  --command company-agent \
  --transport acp \
  --args '["serve","--acp"]'
```

A headless process agent can be added with `--transport process` and
`--prompt-mode stdin|argv`. This command creates and installs the same strict
manifest used by `bivy plugin install`; it is convenience, not a second
configuration model. Use an out-of-process ACP/Bivy-protocol bridge when an
agent needs custom translation. Bivy never imports arbitrary integration code
into the daemon.

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
  bivy: ">=0.10.1 <0.11.0"
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
bivy restart
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
  bivy: ">=0.10.1 <0.11.0" # optional semver range; recommended
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
bivy plugin init [directory] [--id <slug>] [--name <name>] [--adapter acp|process] [--json]
bivy plugin validate <file-or-directory> [--json]
bivy plugin doctor <file-or-directory> [--json]
bivy plugin test <file-or-directory> [--json]
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
An invalid or incompatible plugin is omitted from the agent catalog and does
not prevent other integration packages from starting. Installation fails when the current
Bivy version does not satisfy a declared `requires.bivy` range. Manifests that
omit the range remain compatible for Phase 1 backwards compatibility, while
`doctor` reports the missing pin as a warning.

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
- plugin lockfiles, signatures, or marketplace trust tiers;
- `plugin dev` hot reload and distributable `plugin pack` archives.

The staged roadmap is in
[`internal/developer-platform-implementation-plan.md`](internal/developer-platform-implementation-plan.md).
