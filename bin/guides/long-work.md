# Long and unattended work

Summary: One-shot answers, governed Runs with checks and receipts, and following them.

## One question, one answer

    bivy exec "Summarize the open TODOs in src/" --json

Runs a headless session and prints the answer (`{"sessionId","answer"}` with
`--json`).

## A governed Run

    bivy runs start "Upgrade the test runner and fix what breaks"
    bivy runs list --json
    bivy runs wait <id> --timeout 3600 --json

A Run is unattended work with checks, evidence and a Receipt. `runs wait` exits
0 when it succeeded, 1 when it failed or was cancelled, 2 on timeout.

## While you wait

Tell the user when it matters: `bivy notify "…"` (see `bivy guide talk-to-the-user`).
