# Agent-UX eval

Can an agent, told nothing but Bivy's agent note, use Bivy well? The agent-UX
eval gives real agents small tasks and scores whether they reached the user the
way each task needed: they showed a file, notified the user when done, asked
before acting, offered next steps, or knew where they were running.

It complements [agent certification](../certification/), which checks the
protocol contract with recorded traces. This eval runs real agents and models,
so it costs model usage and is not part of CI. Run it before and after changing
the agent note, a guide, a command's name, or an MCP tool.

## Running it

Start a node whose workspace contains the eval root, with the `bivy` under test
reachable by the agents, then:

```bash
pnpm run eval:agent-ux -- --agents claude-code-sdk,codex-approvals \
  --url http://127.0.0.1:4317 --root /tmp/bivy-agent-ux --json results.json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--agents` | required | Agent ids, as in `bivy agents` |
| `--tasks` | all | Task ids from `certification/agent-ux.json` |
| `--url` | `http://127.0.0.1:4317` | The node to drive |
| `--data-dir` | `$BIVY_DATA_DIR` or `~/.bivy` | That node's data directory (for the audit log and misses) |
| `--root` | `$TMPDIR/bivy-agent-ux` | Where task workspaces are created; must be inside the node's workspace |
| `--timeout` | 300 | Seconds per task |
| `--json` | none | Also write the results as JSON |

On a host where loopback needs a token, set `BIVY_EVAL_TOKEN` to a device token
(`bivy token`).

## What it reports

A table with one row per agent and task:

- **Result**: pass or fail.
- **Time** the task took.
- **Bivy calls**: the calls the agent made with its session token (`agent.call` in
  the audit log).
- **Unknown commands**: `bivy` commands it tried that don't exist. The CLI records
  these as `<data-dir>/agent-cli-misses.jsonl` when it runs inside a session, and
  they are the best hint for what agents expect a command to be called.
- **Failed checks**: which of the task's checks failed.

## Tasks

Tasks are data in [`certification/agent-ux.json`](../certification/agent-ux.json).
Each has a prompt and seed `files`, plus an `answer` the harness gives to any
question card. Its `expect` list takes these checks:

| Check | Passes when |
| --- | --- |
| `{"block": "bivy_notice", "min": 1}` | The transcript has at least `min` cards of that type (`bivy_attachment`, `bivy_notice`, `bivy_suggestion`, …) |
| `{"asked": true}` | The agent raised a question card, through `bivy ask` or its own ask-the-user tool |
| `{"reply": "{machine}"}` | Its last message contains the text; `{machine}` is the node's name |
| `{"file": "*.sh"}` | A file matching the glob exists afterwards |

The scoring lives in `src/certification/agent-ux.ts`.

## Which `bivy` the agent runs

Agents run whichever `bivy` their shell finds first on PATH. That can be another
install, or an older version than the node. The node therefore exports
`BIVY_NODE_CLI`, the path of its own CLI, to every agent. A `bivy` run from PATH
that finds it set, pointing at a different file, runs that CLI instead. So a
node started from a checkout gives its agents the checkout's commands, even when
PATH has an installed `bivy`. Installs older than this handoff don't do it; with
one of those on PATH, put a `bivy` that runs the checkout first on the agents'
PATH.
