# Bivy documentation

**Start here:** [Quickstart](quickstart.md) — install Bivy, start a node, and
run your first agent session.

## Getting started

| Doc | Who it's for |
| --- | --- |
| [quickstart.md](quickstart.md) | First-time users. From nothing to a running agent session. |
| [install.md](install.md) | Anyone choosing an install method, or installing on a specific OS. |

## Using Bivy

| Doc | Who it's for |
| --- | --- |
| [agent-shim.md](agent-shim.md) | Users running an agent Bivy doesn't ship with, and anyone adding a new one. |
| [automations-as-code.md](automations-as-code.md) | Developers defining, validating, simulating, and applying automations from YAML. |
| [agents/](agents/README.md) | Per-agent setup: install command, how to authenticate it, model picker, resume support, and known gaps — one short page per agent in the picker. |
| [troubleshooting.md](troubleshooting.md) | Anyone whose node won't start, won't connect, or won't behave. |

## Remote access

| Doc | Who it's for |
| --- | --- |
| [remote-access.md](remote-access.md) | Users pairing a phone or laptop to reach a node from anywhere. |

## Configuration & reference

| Doc | Who it's for |
| --- | --- |
| [config-as-code.md](config-as-code.md) | Developers managing typed node configuration and repository policy in YAML. |
| [configuration.md](configuration.md) | Complete environment-variable and internal state reference. |
| [cli-reference.md](cli-reference.md) | Anyone looking up a `bivy` command, flag, or subcommand. |
| [runtime-support-matrix.md](runtime-support-matrix.md) | Users deciding which agent to run and what works with it today. |
| [agent-execution-modes.md](agent-execution-modes.md) | Design and implementation plan for choosing protocols, pipes, or PTYs per agent. |
| [session-reliability-plan.md](session-reliability-plan.md) | Standing plan for making live sessions solid: event delivery, status, turn-end, surfacing. |

## Security

| Doc | Who it's for |
| --- | --- |
| [security-model.md](security-model.md) | Anyone evaluating what Bivy protects, what it doesn't, and its 0.1 limits. |
| [key-management.md](key-management.md) | Users deciding where their API keys and tokens live. |
| [credential-sync.md](credential-sync.md) | Users running more than one node who want credentials on all of them. |
| [releasing.md](releasing.md) | How Bivy is distributed on npm, how to verify a release, and how to cut one. |

## Self-hosting

| Doc | Who it's for |
| --- | --- |
| [self-host-quickstart.md](self-host-quickstart.md) | Operators who want the fast, numbered path from an empty VPS to a running stack, plus the full environment variable checklist. |
| [self-host.md](self-host.md) | Operators running their own relay and control plane instead of Bivy Cloud — the deeper ops reference (backups, restore drills, secret rotation, security boundary). |

## Integrations

| Doc | Who it's for |
| --- | --- |
| [github-setup.md](github-setup.md) | Users connecting Bivy to their GitHub account/org so labeled issues dispatch agent runs — the multi-app connect walkthrough. |
| [github-oauth-setup.md](github-oauth-setup.md) | Users connecting Bivy to GitHub for sign-in, and operators configuring the OAuth app (now parameterized for self-hosted domains). |
| [github-work-queue.md](github-work-queue.md) | Users who want the full mechanics of how GitHub issues dispatch agent runs. |
| [linear-work-queue.md](linear-work-queue.md) | Teams dispatching Linear issues to agent runs and GitHub pull requests. |
| [slack-setup.md](slack-setup.md) | Users turning Slack slash commands into agent runs and pull requests. |
| [webhook-recipes.md](webhook-recipes.md) | Users wiring CI, monitoring, or internal systems into Bivy's signed automation queue. |

## Questions

| Doc | Who it's for |
| --- | --- |
| [faq.md](faq.md) | Anyone checking a common assumption about Bivy against what's actually true today. |

---

To report a security vulnerability, see [../SECURITY.md](../SECURITY.md).
