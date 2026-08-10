# Automations as code

Store coding-agent jobs in `.bivy/automations.yaml`, review them like application
code, and test their routing without creating a run.

## Start

```bash
bivy automation init
```

The generated starter is disabled. Edit its repository, instructions, routing,
and safety policy before enabling it.

```yaml
version: 1
automations:
  - id: fix-failed-ci
    name: Fix failed CI
    enabled: true
    trigger: github
    repo: acme/api
    instructions: |
      Investigate the failed CI run, reproduce it locally, make the smallest safe
      fix, run the affected checks, and open a pull request. Never deploy.
    on:
      - event: workflow_run
        actions: [completed]
        conclusions: [failure, timed_out, startup_failure]
        workflows: [CI]
    routing:
      agent: claude-code-sdk
    safety:
      approval: risky
      sandbox: workspace-write
      maxAttempts: 2
```

`id` is the stable reconciliation key. Renaming `name` updates the existing
remote definition; changing `id` creates another definition.

## Validate and inspect

Both commands are local and upload nothing:

```bash
bivy automation validate
bivy automation plan
bivy automation plan --json
```

Validation fails closed on unknown fields, malformed repositories, unsupported
events, duplicate IDs, or unsafe combinations. `plan` and `test` compose each
request with the applying node's safety floor and the repository policy; `apply`
uploads the bounded result, and the daemon enforces the floors again at run time.
Defaults are deliberately
bounded:

- `approval: risky`
- `sandbox: workspace-write`
- `maxAttempts: 2`

`approval: autonomous` with `sandbox: danger-full-access` is rejected unless the
file explicitly sets `allowDangerous: true`. This acknowledgement does not turn
the sandbox into a security boundary; consult the [runtime support
matrix](runtime-support-matrix.md).

## Test an event locally

Create a YAML or JSON fixture:

```yaml
# .bivy/events/failed-ci.yaml
kind: github
repo: acme/api
event: workflow_run
action: completed
conclusion: failure
workflow: CI
```

Then simulate matching:

```bash
bivy automation test --event .bivy/events/failed-ci.yaml
```

The command explains each definition considered, prints the first match and its
effective routing/safety, and exits without creating a run or uploading
instructions. Exit status is `2` when nothing matches.

Fixture fields:

| Field | Meaning |
| --- | --- |
| `kind` | `github`, `linear`, `schedule`, `webhook`, or `manual` |
| `repo` | Optional `owner/name` repository |
| `labels` | Issue, PR, or Linear labels |
| `mention` | Whether the configured app was mentioned |
| `event` | GitHub event family |
| `action` | GitHub event action |
| `conclusion` | Workflow-run conclusion |
| `workflow` | Workflow name |

Simulation uses the same first-match contract as live intake: enabled definitions
in file order, repository filters, then event predicates.

## Apply

```bash
bivy automation apply
bivy automation apply --prune
```

Apply requires an enrolled node (`bivy setup`). It validates first, encrypts each
instruction template with the applying node's room key, and reconciles by `id`.
The control plane receives ciphertext, routing metadata, and safety settings—not
plaintext instructions.

A source-controlled automation is bound to the applying node because only that
node can decrypt its instructions. If `routing.node` is present, it must name the
current node. Run `apply` on each intended target node with the configuration it
should own.

`--prune` removes source-controlled definitions owned by the applying node and
absent from the file. It never deletes definitions created in the app or managed
by another node.

Webhook signing secrets are generated server-side. On creation, `apply` prints
the endpoint and secret once. Store the secret immediately; rotate it in the app
if it was not captured.

## Trigger fields

- `github`: use `on` event rules; `labels` and `repos` are optional filters.
- `linear`: use `labels` and optional `repos`.
- `schedule`: requires `repo` and either:
  - `schedule: { cron: "0 9 * * 1", timezone: Europe/Oslo }`, or
  - `schedule: { at: "2026-08-20T09:00:00Z" }`.
- `webhook`: creates a signed definition-bound webhook.
- `manual`: only runs when dispatched explicitly.

## Bounded autonomy

The file records controls next to the instructions:

```yaml
safety:
  approval: risky
  sandbox: workspace-write
  maxAttempts: 2
```

`maxAttempts` is a hard run-level ceiling from 1 to 10. A node ruleset may allow
fewer attempts, but it cannot exceed this value. If a retry or fallback would
cross the ceiling, Bivy parks the run as **Needs attention** and records the
reason in its evidence timeline.

Unattended repository runs still execute declared `test`, `lint`, and `typecheck`
package scripts where present. Required-check failures fail the run; command
output remains on the node and only bounded status evidence reaches the control
plane.
