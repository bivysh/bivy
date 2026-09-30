# Automate

Summary: Automations as code: write, validate, preview, test, apply and trigger.

Automations live in the repository, in `.bivy/automations.yaml`, and apply like
infrastructure code:

    bivy automation init                           # write a safe starter file
    bivy automation validate                       # check it
    bivy automation plan --json                    # triggers, routing, effective safety
    bivy automation test --event event.json        # which automation an event would start
    bivy automation apply                          # ask the user, then apply
    bivy automation list --json
    bivy automation trigger <id-or-key>            # run one now

A scheduled one (triggers: schedule, github, linear, webhook, manual; the
format is in docs/automations-as-code.md):

    version: 1
    automations:
      - id: nightly-tests
        name: Nightly tests
        trigger: schedule
        schedule: { cron: "0 2 * * *", timezone: UTC }   # or { at: "2026-10-01T09:00:00Z" }
        repo: owner/name                                  # required for schedules
        instructions: |
          Run the test suite. If it fails, open an issue with the failing tests.
        safety:
          approval: risky
          sandbox: workspace-write

From a session, `apply` goes through the machine's approval mode. Usually the
user gets a card listing every change and decides. With "never ask" it applies
at once, and the chat records what changed either way. The command waits up to
90 seconds for an answer and prints apply's output once it's applied (exit 0). Exit 1 means they declined
(don't retry the same thing), and exit 5 means they haven't answered yet: carry
on, and check later with `bivy automation proposal <id> --wait`.
`apply --dry-run` shows the changes without asking anyone.

To pause one, set `enabled: false` on it and apply. Always `validate` and
`plan` first, and say in the chat what the automation will do and when.
`apply --prune` also removes automations the file no longer has.
`bivy automation --help` has every flag.
