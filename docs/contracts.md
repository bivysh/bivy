# Contracts

Everything below is a surface that agents, plugins and other people's code
build on. Each one is versioned in the data itself, so a file written today
says which contract it was written against.

| Surface | Version | Defined in | Docs |
|---|---|---|---|
| Plugin manifest (`bivy.plugin.yaml`) | `apiVersion: bivy.sh/v1alpha1` | `src/plugin-sdk/manifest.ts`; JSON Schema in `packages/plugin-sdk/schema/` | [Plugins](plugins.md) |
| Kit (`bivy.kit.yaml`) | `apiVersion: bivy.sh/v1alpha1` | `src/plugins/kit.ts` | [Plugins](plugins.md#kits-a-whole-setup) |
| Plugin tool process | stdin JSON in, stdout JSON out, exit code | `src/plugins/tools.ts` | [Plugins](plugins.md#tools) |
| Chat widget protocol | MCP Apps `2026-01-26`, plus `bivy/state/set` | `packages/web/src/widgets/host.ts`, `packages/web/public/widget-frame.html` | [Chat widgets](widgets.md#protocol) |
| Widget runtime (`window.bivy`) | the frame's runtime | `packages/web/public/widget-frame.html` | [Chat widgets](widgets.md#what-a-widget-can-do) |
| Message components (`::view{…}`, ` ```bivy ` fences) | component kinds | `packages/core/src/message-components.ts` | [Chat widgets](widgets.md#placing-a-widget) |
| App manifest (`bivy.app.json`) | `version: 1` | `src/apps/types.ts` | [Apps](apps.md) |
| Automations (`.bivy/automations.yaml`) | `version: 1` | `src/automation-config.ts` | [Automations as code](automations-as-code.md) |
| `bivy` commands, `--json` output and exit codes | the command table | `bin/cli-commands.mjs` | [CLI reference](cli-reference.md) |
| MCP tools and resources (`bivy mcp-serve`) | the command table's `tools`, plugin tools, guides | `src/harness/mcp-serve-cli.ts` | [CLI reference](cli-reference.md) |

## How they change

- **Adding is not breaking.** A new optional field, contribution type,
  component kind, widget method, command or `--json` field can arrive in any
  release. Consumers ignore what they do not know: an unknown component kind
  renders a card naming it, and an unknown widget method gets a JSON-RPC
  "method not found".
- **Validation is strict where code runs.** Plugin manifests, kits and
  automations reject unknown fields, so a typo fails at install rather than
  being silently ignored. A field is therefore added to the validator in the
  same release that starts honouring it.
- **Removing or changing a field is a new version.** `v1alpha1` → `v1alpha2`,
  `version: 1` → `version: 2`, announced under **Changed** or **Removed** in the
  [CHANGELOG](../CHANGELOG.md). While a surface is `alpha`, a release may
  replace its version outright.
- **Widgets follow MCP Apps.** When the MCP Apps spec revises, Bivy answers
  `ui/initialize` with the newest version it supports, and Bivy-only behaviour
  stays under the `bivy` names.

## Building on them

An agent extending Bivy for a user needs only the commands: `bivy guide
extend-bivy`, `bivy guide widgets` and `bivy help --json` describe all of the
above in the form an agent reads. The JSON Schema in
`packages/plugin-sdk/schema/bivy.plugin.schema.json` is referenced from
scaffolded manifests, so editors validate as you type.
