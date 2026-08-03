# GitHub work queue

Bivy can turn GitHub issues into background coding sessions on a computer you own. Add a Bivy label to an issue, and Bivy starts work on the matching node, pushes a branch, and opens a pull request back to the same repository.

This is designed for teams and solo developers who already use GitHub Issues as their backlog and want agent work to happen on their own machine, with their own credentials and local toolchain.

## How it works

```text
GitHub issue label/comment
        ↓ webhook push
Bivy control plane
        ↓ relay push hint, with fallback polling
Your Bivy node
        ↓ clone/open repo, run agent in worktree
GitHub branch + pull request
```

1. **You trigger work in GitHub**
   - Add `bivy` to an issue to route it to your default/shared Bivy queue.
   - Add `bivy/<node>` to target a specific node, for example `bivy/macbook` or `bivy/linux-server`.

2. **GitHub pushes an event to Bivy**
   - A GitHub `issues` webhook sends the issue event to Bivy.
   - Bivy verifies the webhook signature using the hook secret for your account.

3. **Bivy queues and routes the work**
   - Bivy records a work item with the repository, issue number, URL, and routing label. The webhook's title/body is not retained — see [Privacy and security model](#privacy-and-security-model).
   - If your node is connected to the relay, Bivy sends it an immediate “work available” hint.
   - If the node is offline, the item stays pending until the node reconnects or polls the queue.

4. **Your node claims the work**
   - The node fetches pending items for labels it serves, such as `bivy` and `bivy/macbook`.
   - Claiming is atomic, so only one node runs a given issue.
   - The node then **signals pickup on the issue itself**: it swaps the routing label (e.g. `bivy`) for `bivy:in-progress` and leaves a comment naming the node ("Bivy has picked this up and started working on it on node `<name>`"), so a human watching the issue can see work has actually started — this happens for every pickup path (label poll, `@`-mention, or the manual "Run…" queue action), including the hosted GitHub-App flow, which otherwise never touches the issue's labels.

5. **The agent runs locally**
   - The node clones or opens the GitHub repository locally.
   - It creates an isolated worktree/branch, deterministically named `bivy/issue-<number>` so it's discoverable later even after a restart.
   - The agent works inside that local checkout with your local tools and credentials, following a first-message prompt that asks it to understand the issue, do thorough work, run the tests/linter/type-checks, and open its own pull request when done. That prompt ships with a strong default but is user-editable — **Settings → Nodes → GitHub issue prompt**.

6. **The agent opens the PR**
   - The agent commits, pushes its branch, and opens the pull request itself (referencing/closing the issue) — there's no separate hard-coded PR-creation step. The node still publishes the branch if the agent didn't push it, and picks up (comments with) any PR the agent opens so the issue reflects what happened.
   - Once a PR exists, the node removes `bivy:in-progress` — the linked PR is now the live "in progress" signal, and GitHub closes the issue automatically when a PR with `Closes #<n>` merges.

## Availability and limits

The GitHub work queue is available on every plan.

- **Free** — interactive CLI/app sessions are unlimited, plus **10 unattended automations per rolling 7-day window** across GitHub, Slack, signed webhooks, and schedules. One queued work item counts once. Capacity returns gradually as jobs pass 7 days. The cap is **soft**: the first job past the allowance still runs with a heads-up; later jobs stay queued until capacity returns. Nothing is lost.
- **Pro / Team** — unlimited automation.

The run cap is only enforced on Bivy Cloud (`ENFORCE_ENTITLEMENTS=1`). Self-hosted stacks run unlimited regardless of plan (see [configuration.md](./configuration.md)).

## Why push instead of repo polling?

The old/local mode polls one configured repository from the node. That works for simple self-hosted setups, but has drawbacks:

- every node needs to know which repo to poll;
- adding another repo requires more configuration;
- work is delayed by the polling interval;
- GitHub already has a better event mechanism: webhooks.

The hosted work queue uses GitHub webhooks instead. Any connected repository can reach Bivy, and Bivy routes the work to the right node.

The node still has a fallback poll against Bivy’s control-plane queue, so no work is lost if the relay push is missed.

## Privacy and security model

Bivy is split into three parts:

| Part | What it sees |
| --- | --- |
| GitHub | The issue, repository, branch, PR, and comments, as usual. |
| Bivy control plane | Account/node metadata, queued work identifiers (repo slug, issue number, URL), routing/status, and a sanitized run-evidence record (see below). |
| Bivy relay | Only connection/routing envelopes and the `work.available` hint. It does not receive repository contents or agent output. |
| Your node | Repository contents, local files, tool output, model credentials, GitHub token, and the full agent session. |

Important details:

- **Code runs on your machine.** The agent session is created by your Bivy node, not in Bivy’s cloud.
- **Repository contents are not uploaded to Bivy.** The node clones/fetches directly from GitHub using your node’s GitHub credentials.
- **GitHub write credentials stay on the node.** The control plane does not need your repo token to clone, push, or open PRs.
- **Webhook signatures are verified.** Each GitHub webhook uses a per-account secret.
- **Relay push is only a hint.** A relay message says “work is available”; the node still authenticates to the control plane and atomically claims the item before running it.
- **Offline is safe.** Pending work waits in the queue until an eligible node comes online.

### What Bivy stores for the queue

For GitHub issue work, Bivy currently stores:

- repository slug, for example `owner/repo`;
- issue number and URL;
- routing label, for example `bivy` or `bivy/macbook`;
- queue status and lifecycle timestamps (created/claimed/started/completed) and node id;
- a sanitized run-evidence record: routing reason, output references (branch/
  checkpoint/commit/PR/artifact), declared-check pass/fail/exit status, and a
  bounded, allowlisted event timeline — see
  [Run evidence and outcome reports](./automation-runs.md#run-evidence-and-outcome-reports).

Issue/comment title and body are **not** stored. The webhook payload carries
them, but the control plane discards them immediately after routing; the node
that claims the item fetches the live issue/comment text directly from GitHub,
with its own credentials, right before it prompts the agent.

Bivy does **not** store repository files, diffs, terminal output, model transcripts, model API keys, or GitHub access tokens for the node.

## Setup

Setup is a **GitHub App** — one webhook covering every repo you install it on
(no per-repo webhook or repo-admin token). Three ways to set it up, all of which
keep the app's private key on the node:

- **From the web app:** *Settings → GitHub App → Create GitHub App*. Works
  remotely (through the hosted control plane) as well as on a local node.
- **`bivy github:app-create`:** drives the same one-click manifest flow from the
  CLI (opens a browser, or prints instructions on a headless box).
- **`bivy github:app-connect --app-id <id> --key <path.pem>`:** connect an app
  you created yourself, no browser required.

### Personal repos and organizations

A **private** GitHub App can only be installed on the account that owns it. One
app therefore cannot cover both your personal repositories and an organization's.

So connect one app per GitHub account: one owned by you, and one owned by each
org you want Bivy to work in. The create flow takes an organization — *Settings →
GitHub App → Add an app*, fill in the organization field, or
`bivy github:app-create --org <org>` — which creates the app under that org
instead of your user account.

A node can hold several apps at once. Each keeps its own private key in the
node's vault and its own webhook, and each gets its own `@`-mention handle, so
mentioning one app never triggers another. When Bivy needs a token for a
repository it picks the app that is installed there, trying the app owned by that
same account first.

The alternative — making a single app public so it can be installed anywhere — is
not recommended: a public app can be installed by anyone, and every installation
delivers to the owner's webhook.

Then install the app on your repositories and label an issue with `bivy` (or
`@`-mention the bot in a comment). To target a specific node, add a node label
(e.g. `bivy/macbook`) — see below.

The lower-level API remains available for custom automation: `POST /account/hooks`
for a signed-in user, or `POST /node/hooks` from an enrolled node.

> The older per-repo `bivy github:setup owner/repo` webhook + personal-token
> flow has been removed in favor of the GitHub App.

## Routing labels

Use labels to control where work runs:

| Label | Behavior |
| --- | --- |
| `bivy` | Shared/default queue. Any node serving `bivy` may claim it. |
| `bivy/macbook` | Target a specific node label. |
| `bivy/linux-server` | Useful for Linux-only builds, deploy tooling, GPUs, etc. |

Specific labels win over generic ones when both exist.

### Label lifecycle

An issue's Bivy label moves through the pickup → in-progress → PR lifecycle
rather than accumulating:

1. You (or a previous run) apply a routing label — `bivy` or `bivy/<node>`.
2. On pickup, the node adds `bivy:in-progress` and removes the routing label,
   and comments to say it has started.
3. Once the agent's pull request is open, the node removes `bivy:in-progress` —
   the PR itself is now the visible signal, and it (plus the issue, once the PR
   merges with `Closes #<n>`) is the thing to watch from there.

If the agent finishes without opening a PR (no changes, or it pushed but
stopped short), `bivy:in-progress` is left in place so the issue isn't silently
re-picked-up by the label poller; comment `@bivy` again (or use the manual
"Run…" queue action) to continue.

### Default node

By default the bare `bivy` label is a free-for-all: any online node serving
`bivy` may claim the work. If you'd rather untagged/`@`-mention-only work land
on one particular machine, set **Settings → GitHub App → Default node** in the
web app. Once set, anything that would have routed to the bare `bivy` queue is
rewritten to `bivy/<default node>` before it's enqueued — an explicit
`bivy/<node>` label or `on <node>` directive on the issue/comment still always
wins over the default.

### Who can trigger runs

On a **public** repository, anyone can open an issue or leave a comment —
by default, `@`-mentioning the bot there queues a run for whoever wrote it,
same as a collaborator would get. Applying a routing label is unaffected
(GitHub itself only lets collaborators/triage-access users add labels), but
the `@`-mention trigger has no such implicit protection on its own.

Set **Settings → GitHub App → Who can trigger runs** to restrict it, based on
GitHub's own `author_association` for the issue/comment author:

| Setting | Who can trigger | GitHub `author_association` |
| --- | --- | --- |
| Everyone (default) | Any GitHub user | any, including `NONE` |
| Contributors | Anyone with a prior relationship to the repo | `CONTRIBUTOR`, `COLLABORATOR`, `MEMBER`, `OWNER` |
| Collaborators only | Push access only | `COLLABORATOR`, `MEMBER`, `OWNER` |

This is one account-wide preference applied to every connected app. A blocked
mention is acknowledged to GitHub (so it doesn't retry the delivery) but
enqueues nothing — no comment is left, so it's silent from the blocked user's
point of view.

## Failure behavior

- **Node offline:** work remains pending and starts when a matching node reconnects.
- **Two nodes eligible:** only one wins the atomic claim.
- **Agent produces no changes:** Bivy comments that no file changes were produced.
- **Push/PR fails:** the item is marked done after the run attempt; the issue/PR trail should show what happened where possible.
- **Relay unavailable:** fallback polling still picks up pending work.

## Local/self-hosted fallback

Bivy still supports the older direct repo poller for simple local setups:

- `BIVY_GITHUB_TOKEN`
- `BIVY_GITHUB_REPO=owner/repo`
- optional `BIVY_GITHUB_LABEL`, `BIVY_GITHUB_REPO_DIR`, `BIVY_GITHUB_POLL_MS`

That mode is useful when you do not want a hosted webhook sink, but the recommended hosted path is webhook push into Bivy’s work queue.
