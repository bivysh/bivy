# Automations as code

Store coding-agent jobs in `.bivy/automations.yaml`, review them like application
code, and test their routing without creating a run.

## List and trigger

Once the node is enrolled, list every automation on its account and manually
start one by immutable id or source-controlled key:

```bash
bivy automation list
bivy automation list --json
bivy automation trigger fix-failed-ci
```

`trigger` creates a real manual run and prints its run id. Use `--json` for the
complete run record. `bivy automation run` is an alias.

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
instructions. It also prints overlap/shadow warnings across the whole file (an
earlier automation whose scope is a superset of a later one makes the later one
unreachable) and a preflight checklist for the matched automation — see
[automation-evaluator.md](automation-evaluator.md) for what each check means and
which of them require the control plane (and so report "skipped" here; `apply`
and the app's Test event workflow see the real signal). Exit status is `2` when
nothing matches, or when the checklist blocks. `validate` prints the overlap
warnings too, without needing a fixture.

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

Simulation uses the same first-match contract as live intake — literally the same
code, not just the same rules (see [automation-evaluator.md](automation-evaluator.md)):
enabled definitions in file order, repository filters, then event predicates.

## Filter webhook deliveries before starting an agent

Generic `trigger: webhook` automations can run a trusted executable on their
assigned node. GitHub/Linear-specific triggers are not supported by this first
version. Signature verification and intake limits still happen first; the filter
runs after queue claim but before repository fetching or any agent session.

```yaml
version: 1
automations:
  - id: review-ready-pr
    name: Review ready PR
    trigger: webhook
    repo: acme/api
    instructions: Review the incoming PR.
    filter:
      command: [node, ready-pr.mjs]
      cwd: /srv/bivy/trusted-filters
      timeoutSeconds: 5
```

`command` is an argv list, executed directly without shell interpolation.
JavaScript, Python, shell scripts, or compiled executables work if their runtime
is installed on the assigned node. `cwd` is required and absolute: deploy your
reviewed, version-controlled scripts there yourself. Bivy does **not** check out
filter code from the webhook's repository or PR. Do not point it at an
agent-writable or untrusted checkout. Executable lookup uses the node's `PATH`;
use an absolute executable path if you need to pin the interpreter.

The filter receives one JSON object on stdin:

```json
{"version":1,"event":{"type":"webhook","payload":{"pull_request":{"draft":true}}},"delivery":{"id":"run-id"}}
```

`event.payload` is the original parsed webhook JSON (object or array), including
the full Bivy envelope if one was supplied. `delivery.id` is Bivy's stable run ID,
not a provider delivery header. Authentication headers and signing secrets are
never included. The payload is untrusted data.

Example `ready-pr.mjs`:

```js
let text = "";
for await (const chunk of process.stdin) text += chunk;
const { event } = JSON.parse(text);
console.log(JSON.stringify(event.payload.pull_request?.draft === true
  ? { decision: "skip", reason: "Draft PR" }
  : { decision: "accept" }));
```

Stdout must contain exactly one JSON object with `decision: accept|skip` and an
optional `reason` (up to 500 characters). No prompt rewriting, payload
transformation, or routing overrides are accepted. Stderr is for diagnostics.

Test the real executable locally, with a **raw webhook payload** JSON fixture:

```bash
bivy automation test-filter --id review-ready-pr --event .bivy/events/draft-pr.json
```

This executes trusted code, but creates no run and uploads nothing. Both accept
and skip exit `0` and print the decision JSON; execution/validation failure exits
`1`. Normal `automation test` remains a non-executing routing simulation.

Operational behavior:

- Accept starts the agent normally. Skip ends this automation without an agent
  and never tries another automation. The run completes successfully with a
  **skipped `webhook-filter` check** and an explanatory timeline event; there is
  no new top-level run status.
- Nonzero exit, invalid JSON, timeout, or oversized output parks the run as
  **needs attention**, with a failed filter check. Agent retry/fallback policy
  does not retry filter errors. Manual runs without webhook data fail closed.
- Decisions/reasons appear in run evidence (`bivy runs status <id>`); keep reasons
  free of secrets. Raw stderr remains in node logs (or local CLI stderr), never
  uploaded as run evidence.
- Timeout defaults to 5 seconds (configurable 1–60). Input is capped at 256 KiB;
  stdout and stderr are each capped at 16 KiB. Cancellation stops execution;
  on POSIX, timeout/cancellation also kill the spawned process group.
- The environment contains only `PATH`, `LANG`, and Windows `SystemRoot` when
  needed—not inherited credentials, home directory, or interpreter options.
  **This is not a sandbox:** scripts run as the daemon user and can access its
  files/network. Agent sandbox settings do not constrain filters.
- Filters should be side-effect-free: a reclaimed/retried delivery can execute
  again. Provision the trusted directory on every intended node; ephemeral
  machines do not automatically receive local scripts.

Filter configuration travels with the encrypted instruction template, not as
plaintext commands in the control plane. Upgrade the CLI, node daemon, and
control plane before enabling filters: older daemons do not enforce the new
filter field. Apply again after changing command, directory, or timeout; script
file changes take effect on the next execution.

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
