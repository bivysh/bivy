# Add any agent

Any coding agent that runs on your machine can run through Bivy. If it speaks
[ACP](https://agentclientprotocol.com), point Bivy at its command. If it is any
other CLI, point Bivy at that command, or write a small adapter for it. All
three are a few lines in `<data-dir>/config.yaml`, and they appear in the agent
picker as soon as the file is saved. No restart, no Bivy source change.

## From the command line

```bash
# An ACP agent
bivy agent add gemini-acp --command gemini --args '["--experimental-acp"]'

# Any CLI that takes a prompt on stdin (or as its last argument: --prompt-mode argv)
bivy agent add review-bot --transport process --command review-bot --args '["run"]'

bivy agent list
bivy exec -a gemini-acp "Say hello"    # one real turn, prints the answer
bivy agent remove gemini-acp
```

`bivy agent add` writes the `agents:` entry below; edit the file for every other
option.

## In config.yaml

```yaml
agents:
  gemini-acp:
    name: Gemini (ACP)
    adapter:
      kind: acp
      command: gemini
      args: [--experimental-acp]

  review-bot:
    name: Review Bot
    adapter:
      kind: process
      command: review-bot
      args: [run]
      promptMode: argv            # stdin (default) or argv
      structured:                 # optional: parse its JSON output
        args: [run, --json]
        parser: generic-stream-json
      resume:                     # optional: continue the same conversation
        args: [run, --resume, "{id}"]
      model:                      # optional: a model picker
        flag: --model
        choices:
          - { id: fast, name: Fast }
          - { id: thorough, name: Thorough }
```

The `adapter` block is the same one a [plugin](plugins.md) manifest uses, so an
agent you set up here can later be shared as a plugin unchanged. `bivy config
validate` checks the file; a broken file shows in `bivy plugin list` and keeps
every other agent working.

What each kind gets:

| Kind | Streaming | Approve each tool before it runs | Resume | Models |
| --- | --- | --- | --- | --- |
| `acp` | Yes | Yes, when the agent asks | Yes (`session/load`) | When the agent advertises them |
| `process` | Yes; text, or tool cards with a `structured` parser | No: it runs with your user's permissions | With `resume.args` | With `model` |

Prefer ACP when the agent supports it. A `process` agent cannot ask before its
own tools act, so run it in a container or VM for unattended work.

## Write an adapter

When a CLI has no ACP mode and its output isn't one of the
[built-in parsers](plugins.md#process-agent), write a small program that
translates. Bivy runs it once per turn in the session workspace, writes the
prompt to its stdin, and reads one JSON event per line from its stdout. That is
the whole contract: any language works.

```yaml
agents:
  my-agent:
    adapter:
      kind: process
      command: /path/to/adapter
      structured: { args: [], parser: bivy-protocol }
      resume: { args: [--resume, "{id}"] }
```

### Events

| Event | Fields | Shows as |
| --- | --- | --- |
| `session.started` | `sessionId` | Nothing; Bivy passes it back as `{id}` in `resume.args` on the next turn |
| `message.delta` | `text` | Answer text, appended |
| `message.reasoning` | `text` | A reasoning block |
| `tool.call` | `toolCallId`, `name`, `input` | A tool card. `name` `bash` with `input.command`, or `edit`/`write` with `input.path`, get the rich shell and file cards |
| `tool.result` | `toolCallId`, `result` | The tool card's output |
| `usage` | `tokens` (`input_tokens`, `output_tokens`, …), `costUsd` | The session's usage |
| `session.done` | | End of turn |
| `session.error` | `error` | An error on the turn |

Lines that aren't JSON are ignored, so banners and logs on stdout are harmless.
A non-zero exit without `session.done` ends the turn with stderr as the error.

[`examples/agents/jsonl-adapter/adapter.mjs`](../examples/agents/jsonl-adapter/adapter.mjs)
is a complete adapter in 50 lines: it emits every event above and resumes. Copy
it, replace `runTurn` with calls to the agent you are wrapping, and try it:

```bash
bivy agent add my-agent --transport process --parser bivy-protocol \
  --command "$PWD/adapter.mjs" --resume-args '["--resume","{id}"]'
bivy exec -a my-agent "List the files here"
```

### When you need approvals

The turn format reports what the agent did; it cannot ask first. If your adapter
should stop and ask before a tool runs, make it an ACP agent instead (the
[ACP SDKs](https://agentclientprotocol.com/libraries) cover TypeScript, Python
and Rust) and use `kind: acp`. Bivy turns each `session/request_permission` into
an Approve / Deny prompt on your phone. A minimal ACP agent is in
[`examples/plugins/acp-agent`](../examples/plugins/acp-agent).

## Share it

To give the agent to other people or machines, wrap the same `adapter` block in a
plugin manifest: see [Plugins](plugins.md). Environment-variable setups
(`BIVY_ACP_COMMAND`, `BIVY_AGENT_COMMAND`, `BIVY_PROTOCOL_COMMAND`) still work
and hold one agent each; `config.yaml` holds any number.
