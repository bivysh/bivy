# More hands: other agents and machines

Summary: Delegate a task to another agent or machine, compare several, and follow the result.

Use your own sub-agents for ordinary work. Delegate only when the user asks for
another agent or another of their machines.

    bivy delegate machines                                   # machines and their agents
    bivy delegate "Review this branch for bugs" --agent codex --wait
    bivy delegate "Run the Linux-only build" --machine build-box --agent claude --wait
    bivy delegate "Propose a fix for issue 42" --to codex,claude@laptop --wait

Write the task so it stands on its own: the other agent does not see this chat.
`--wait` prints the child's answer and any branch or PR it pushed. Without it you
get a run id: `bivy delegate status <id>`, `bivy delegate wait <id>`.
Code comes back by git: fetch the branch or review the PR.

To try another approach from the same point, fork this session and give the
copy its task (it gets its own branch):

    id=$(bivy fork --json | jq -r .sessionId)
    bivy send "$id" "Try the same fix with a streaming parser instead."

For unattended work with checks and a receipt, see `bivy guide long-work`.
