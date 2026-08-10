# Configuration as code

Bivy has two typed YAML configuration surfaces with different ownership.

## Node configuration

`<data-dir>/config.yaml` is the canonical, user-authored configuration for one
node. Create it from an existing installation safely:

```bash
bivy config init
bivy config validate
bivy config show
```

Example:

```yaml
version: 1
node:
  workspace: /srv/code
  port: 4317
  maxConcurrentAutomations: 2

defaults:
  agent: claude-code-sdk
  model:
    provider: anthropic
    id: claude-sonnet
  sandbox: workspace-write
  approval: risky

# Machine-wide floors; run and automation choices may only tighten these.
safety:
  maxSandbox: workspace-write
  approvalFloor: risky

sessions:
  sync: true
  worktreeSync: false
  resume: auto
  autoAttachToolImages: false

automation:
  checks: [test, lint, typecheck]
  checkTimeoutMinutes: 10

agents:
  company-codex:
    extends: codex
    command: company-codex
    args: [exec]

environment:
  BIVY_GITHUB_TOKEN: secret://github.repo-token
```

The CLI and web Settings screen edit the same typed file. `safety` is a
machine-wide floor: per-run, automation, and repository choices cannot request
a more permissive sandbox or less restrictive approval posture. `cli.json` and
`settings.json` remain generated compatibility projections for older binaries;
do not hand-edit them once `config.yaml` exists.

### Inspect and edit

```bash
bivy config path
bivy config get defaults.agent
bivy config set defaults.agent codex
bivy config set node.maxConcurrentAutomations 2
bivy config set automation.checks '[test, lint, typecheck]'
bivy config unset defaults.model
bivy config explain defaults.sandbox
```

`set` values are YAML scalars/collections and the entire document is validated
before it is replaced atomically. Unknown keys, string booleans, invalid enums,
and out-of-range numbers fail closed.

`explain` reports the effective value and source:

```text
defaults.sandbox = read-only
source: environment BIVY_SANDBOX
config file: "workspace-write" (overridden)
```

When run inside a repository, safety explanations also apply the nearest
`.bivy/policy.yaml` and identify any environment/node request restricted by its
sandbox ceiling or approval floor.

Restart the node after changing boot settings.

### Secrets

Do not put plaintext credentials in `config.yaml`. Sensitive environment names
must use a reference:

```bash
bivy secrets set github.repo-token
bivy config set environment.BIVY_GITHUB_TOKEN secret://github.repo-token
```

`secret://`, `env://`, and `op://` references are resolved by the Bivy launcher.
Identity, pairing, credentials, transcripts, caches, and enrollment records
remain internal state—not public configuration.

## Repository policy

A repository may own `.bivy/policy.yaml`:

```bash
bivy config init --project
bivy config validate --project
```

```yaml
version: 1
safety:
  maxSandbox: workspace-write
  approvalFloor: risky
checks:
  scripts: [test, lint, typecheck]
  timeoutMinutes: 10
routing:
  allowedAgents: [pi, codex]
  allowedModels: [gpt-5, gpt-5-mini]
ruleset:
  version: 1
  name: repository
  appliesTo: [queue]
  rules:
    - when: [transport_error, node_offline]
      action: retry
      maxAttempts: 2
      backoff:
        baseMs: 2000
        factor: 2
        capMs: 30000
        jitter: 0.2
    - when: [auth_failed, credits_exhausted]
      action: park
      maxAttempts: 1
```

Repository policy is discovered from the prepared checkout/worktree. Safety and
routing bounds apply to every session there; checks and retry rules govern
unattended runs:

- `maxSandbox` is a ceiling: the more restrictive value between the run and
  repository wins.
- `approvalFloor` is a floor: repository policy may require `risky` or `always`,
  never fewer approvals.
- `checks` replaces the node's default package-script list for that repository.
- `routing` restricts agents and model IDs for sessions in that repository.
- `ruleset` replaces the node-global queue ruleset for failures in that
  repository.

Policy can only tighten safety. A trigger payload cannot override it. Agent
allowlists are checked when sessions open, and model allowlists are checked when
a model is selected.

## Precedence

For ordinary scalar defaults:

1. One-run CLI/per-session override.
2. Automation definition.
3. Real process environment.
4. Node `config.yaml`.
5. Built-in default.

Repository safety uses restrictive composition rather than last-writer-wins.
For example, `danger-full-access` requested by an automation under a repository
whose `maxSandbox` is `workspace-write` runs as `workspace-write`.

Repository checks and queue rulesets take precedence over node defaults because
they are reviewed with the code they govern.

See [automations-as-code.md](automations-as-code.md) for trigger definitions and
[configuration.md](configuration.md) for the complete environment-variable
reference.
