# GitHub event rules (automations)

## Model

Three layers — do not add new top-level trigger enums for each GitHub event.

| Layer | What it is |
|---|---|
| **Connection** | The GitHub App (one install). Subscribes to a curated event set in the manifest. |
| **Automation** | A *job*: instructions + machine/agent + filters. **Outcomes are whatever the instructions say** (comment, open a PR, fix code, …). Nothing is hard-coded to “always open a PR”. |
| **Event rules (`on[]`)** | Which deliveries fire this job. Labels and @mentions are predicates on surfaces that carry them. |

Legacy `trigger: "github_ci"` still works: matching expands it to a `workflow_run` failure rule. New UI writes `trigger: "github"` + explicit `on`.

## Rule shape

```ts
on: Array<{
  event: "issues" | "issue_comment" | "pull_request"
       | "pull_request_review_comment" | "workflow_run";
  actions?: string[];       // e.g. labeled, completed
  labels?: string[];        // default bivy / bivy/<node>
  mention?: boolean;        // @app handle; skips label requirement
  conclusions?: string[];   // workflow_run
  workflows?: string[];     // workflow_run name allowlist
}>
```

Any matching rule fires the automation (plus repo allowlist).

## Labels & @mentions

### Choose your own trigger labels

In **Automations → create/edit an automation → GitHub trigger**, enable
**Issue labeled** and/or **Pull request labeled**, then edit **Trigger labels**.
Use your own names, such as `fix-it` or `ready for review`, separated by commas.
Any one of them can start that automation. `bivy` is the sensible default when
the field is left blank; it is not a required prefix for custom labels.

Labels belong to each automation's trigger rules, **not** the GitHub App
connection. Hosted and custom GitHub Apps use the same matching logic.
The automation's machine selection determines where the run executes; a custom
trigger label does not become a machine name or queue name.

For a GitHub `labeled` delivery, matching uses the label just applied. Adding an
unrelated label does not restart work merely because a trigger label was already
on the issue or PR. Repository/app filters and paused automations still apply.

Example rules for custom labels on both issues and pull requests:

```json
[
  { "event": "issues", "actions": ["labeled"], "labels": ["fix-it", "ready for review"] },
  { "event": "pull_request", "actions": ["labeled"], "labels": ["fix-it", "ready for review"] }
]
```

### Mention events

Applied on every surface that has them:

- Issues (labeled / body @mention)
- Issue comments and PR conversation comments (`issue_comment`)
- Pull requests (labeled / body @mention)
- PR review comments (`pull_request_review_comment`)

@mention is sufficient intent (label filter not required). Who-can-trigger still gates actor-driven paths.

## App subscription

Manifest `default_events` is the capability set (today: issues, issue_comment, pull_request, pull_request_review_comment, workflow_run). Automations pick subsets via `on`. Expanding the set is a manifest/permissions change, not a new product surface.
