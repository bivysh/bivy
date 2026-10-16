# Add an agent: any ACP agent or CLI

Summary: Make another coding agent available in Bivy, writing a small adapter when its CLI needs one.

An agent with an ACP mode needs only its command:

    bivy agent add gemini-acp --command gemini --args '["--experimental-acp"]'

Any other CLI that takes a prompt on stdin (or as its last argument with
`--prompt-mode argv`):

    bivy agent add review-bot --transport process --command review-bot --args '["run"]'

It is in the picker at once. Check it with one real turn, which prints the answer:

    bivy exec -a gemini-acp "Say hello"

When the CLI's output needs translating, write an adapter: a program Bivy runs
once per turn with the prompt on stdin. It prints one JSON event per line:

    {"type":"session.started","sessionId":"abc"}     # passed back as {id} to resume
    {"type":"message.reasoning","text":"…"}
    {"type":"tool.call","toolCallId":"t1","name":"bash","input":{"command":"ls"}}
    {"type":"tool.result","toolCallId":"t1","result":"…"}
    {"type":"message.delta","text":"The answer…"}
    {"type":"usage","tokens":{"input_tokens":10,"output_tokens":20}}
    {"type":"session.done"}                          # or {"type":"session.error","error":"…"}

Start from examples/agents/jsonl-adapter/adapter.mjs in the Bivy repo, then:

    bivy agent add my-agent --transport process --parser bivy-protocol \
      --command "$PWD/adapter.mjs" --resume-args '["--resume","{id}"]'
    bivy exec -a my-agent "List the files here"

These events report what the agent did; they cannot ask before a tool runs. For
approvals, the adapter must speak ACP (`--transport acp`).

The entry lives under `agents:` in the node's config.yaml (`bivy agent list`,
`bivy agent remove <id>`). The full format is in docs/add-an-agent.md.
