# Slack requests

Bivy can turn a Slack slash command into an unattended agent run on one of your nodes. A request can optionally target a GitHub repository; repository requests run in an isolated worktree and ask the agent to push a branch and open a pull request.

## Connect Slack

1. In Slack, create an app at <https://api.slack.com/apps>.
2. Open **Basic Information → App Credentials** and copy the **Signing Secret**.
3. In Bivy, open **Settings → Slack**, paste the secret, optionally choose a default node, and select **Connect Slack**.
4. Copy the Request URL Bivy displays.
5. In the Slack app, open **Slash Commands**, create `/bivy`, and paste that Request URL.
6. Install or reinstall the app to your workspace.

Bivy stores the signing secret only to verify Slack's request signatures.
Requests older than five minutes and requests with invalid signatures are
rejected. The slash-command text necessarily reaches Bivy Cloud in plaintext
and is retained as the queued run's title until that run is deleted, so do not
put credentials or other secrets in `/bivy` commands. Repository contents,
agent transcripts, and model credentials still stay on the node.

## Commands

```text
/bivy fix the failing tests
/bivy on macbook fix the failing tests
/bivy in owner/repo fix the failing tests
/bivy on macbook in owner/repo fix the failing tests
```

- `on <node>` routes to that named Bivy node. Without it, Bivy uses the integration's default node or the shared queue.
- `in <owner/repo>` clones or refreshes that GitHub repository, creates an isolated worktree, and instructs the agent to test, commit, push, and open a pull request. The node must have access to the repository through its connected GitHub App or GitHub token.
- With neither clause, the request runs in the node's configured default workspace. If that workspace is a GitHub checkout, Bivy still creates an isolated worktree.

Slack receives an immediate private acknowledgement. Progress and outcomes appear in **Runs**; completed repository Runs include the pull-request URL when one was opened.

## Troubleshooting

- **Slack says the command failed:** confirm the slash command's Request URL exactly matches the URL shown in Bivy and that the Signing Secret belongs to the same Slack app.
- **A request stays pending:** make sure the target node is online. Enrolled nodes automatically listen for Slack work; no GitHub issue-pickup environment flag is required.
- **Repository request cannot clone or push:** connect a GitHub App to that repository or configure a GitHub token on the node.
