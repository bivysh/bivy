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

Applied on every surface that has them:

- Issues (labeled / body @mention)
- Issue comments and PR conversation comments (`issue_comment`)
- Pull requests (labeled / body @mention)
- PR review comments (`pull_request_review_comment`)

@mention is sufficient intent (label filter not required). Who-can-trigger still gates actor-driven paths.

## App subscription

Manifest `default_events` is the capability set (today: issues, issue_comment, pull_request, pull_request_review_comment, workflow_run). Automations pick subsets via `on`. Expanding the set is a manifest/permissions change, not a new product surface.
