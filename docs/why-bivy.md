# Why Bivy

> **Run agents where your environment lives. Reach, automate, and govern them
> from anywhere.**

Bivy makes coding agents on your infrastructure available from anywhere. They
can use the repositories, tools, services, caches, networks, and compute already
present in your development environment; you can continue their Sessions from a
phone, leave work running, and review checked outcomes without surrendering
control of the Machine.

## The problem

A coding agent is most capable in the environment where the real work lives.
That is often a developer workstation, a private server, or an isolated Machine
in your own cloud—not a generic hosted sandbox. But an agent tied to one
terminal is difficult to reach, supervise, or trust with unattended work.

Bivy closes that gap:

- **Capability:** use the real repository and development environment.
- **Freedom:** choose a supported agent, model, Machine, and cloud.
- **Reach:** reconnect, steer, stop, and approve from another device.
- **Autonomy:** turn live work into background Runs and Automations.
- **Safety:** show effective protection, checks, outcomes, and Receipts.
- **Sovereignty:** keep control of execution; when you bring your own cloud
  Machines you pay the provider directly, and Bivy resells no compute.

## The product loop

```text
Install Bivy
→ use Claude Code or Codex in a real environment
→ continue from phone
→ leave work running
→ receive checked changes or a pull request
→ review a clear Receipt
```

A **Session** is live agent work that can be steered and resumed. A **Run** is
delegated work with checks and an explicit outcome. An **Automation** creates
Runs from GitHub, Linear, Slack, a schedule, or a webhook. Work executes on a
**Machine** (the node daemon on a computer you control): either a trusted
workstation or an isolated environment in your own cloud. The **Inbox**
collects questions, approvals, failures, and completed work. A **Receipt** reports what Bivy observed and enforced, what
changed, which checks passed, and what it could not observe.

## Use the environment where the work lives

Agents can use existing repositories and files, local services and databases,
established tools and caches, private networks, GPUs and local models, and
long-running processes—subject to the permissions and protection of the chosen
Machine and runtime.

Bivy does not replace Claude Code, Codex, or another coding agent. It provides a
consistent layer for remote continuity, unattended execution, recovery,
approvals, checks, and bounded evidence around supported agents.

## Continue from anywhere

A Machine dials out to an end-to-end encrypted relay, so it does not need an
inbound public port. Interactive frames are encrypted between the Machine and
the paired device. The relay can route, delay, or drop those frames and observe
routing metadata, but cannot decrypt their content.

From a phone or another computer, a developer can reconnect to the same Session,
answer a question, approve or deny an action, stop work, or leave it running.
The CLI alone needs no account. A browser or phone needs a control plane —
hosted or self-hosted — which also brings the node registry, notifications,
Automations, and hosted provisioning options; a device paired by QR /
`bivy link` reaches one Machine without signing in to the account.

## Leave work running and review an outcome

A live Session can continue in the background without copying it into a separate
chat system. A manual task or GitHub issue can become a Run on an isolated
worktree. Bivy runs deterministic repository checks and derives a conservative
outcome such as **PR open**, **Changes ready**, **Checks failed**, or **Needs
review**. A successful process exit alone is never treated as proof of success.

Receipts are bounded observation reports. They exclude prompts, transcripts,
reasoning, diffs, file contents, check output, raw tool payloads, and secrets.
Receipt v1 is not a signed attestation; missing or uncorrelated evidence is shown
as a limitation rather than silently omitted.

## Choose the execution profile

Bivy describes three execution profiles:

- **Trusted workstation:** maximum context and capability in your real
  environment. Work runs with your OS permissions; Bivy is not an OS
  isolation boundary.
- **Isolated cloud Machine:** stronger isolation and reproducibility in a VM or
  container you control and pay for. Provider support is experimental until a
  path is live-certified.
- **Restricted/read-only:** narrowly scoped investigation where the selected
  runtime or OS mechanism can enforce the restriction.

The UI reports requested and effective protection separately and distinguishes
controls that are **enforced**, signals that are only **observed**, and
capabilities that are **unavailable**. Effect-level interception must not be
confused with machine isolation.

## A precise trust boundary

> **Bivy is blind on the E2E relay and a credential custodian in explicitly
> enabled hosted-provisioning paths.**

Interactive traffic and workspace content remain encrypted across the relay.
However, unattended hosted provisioning can require the control plane to store
encrypted cloud, repository, or key-escrow material that the service can
technically access. Third-party sources such as Slack and generic webhooks also
send their bounded instructions to the control plane in plaintext. These are
explicit trust modes, not cryptographic blindness.

You can self-host the relay and control plane, keep relevant keys on your own
devices, or explicitly opt into hosted custody where unattended launch requires
it. See the [security model](security-model.md) and
[hosted-provisioning trust model](hosted-provisioning-trust-model.md) for the
current implementation boundaries.

## Who Bivy is for

Bivy is built first for individual developers already using Claude Code, Codex,
or Pi locally who want persistent remote access, unattended Runs, Automations,
notifications, recovery, and coordination across several Machines — without
giving up the environment they already have.

Shared policy, approver routing, budgets, evidence retention, and signed audit
are not part of Bivy today; treat any mention of them as direction, not a
current claim.

In one line: keep the environment you have, reach it from anywhere, leave work
running, and see what happened.
