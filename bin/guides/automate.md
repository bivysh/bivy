# Automate

Summary: Automations as code: write, validate, preview, test, apply and trigger.

Automations live in the repository, in `.bivy/automations.yaml`, and apply like
infrastructure code:

    bivy automation init                           # write a safe starter file
    bivy automation validate                       # check it
    bivy automation plan --json                    # triggers, routing, effective safety
    bivy automation test --event event.json        # which automation an event would start
    bivy automation apply                          # reconcile the account with the file
    bivy automation list --json
    bivy automation trigger <id-or-key>            # run one now

Always `validate` and `plan` before `apply`, and show the user the plan when it
changes something they didn't ask for. `apply --prune` also removes automations
the file no longer has. `bivy automation --help` has every flag.
