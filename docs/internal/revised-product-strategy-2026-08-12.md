# Bivy revised product strategy

**Date:** 2026-08-12
**Status:** Accepted
**Product contract:** [`product-contract.md`](product-contract.md)
**Delivery plan:** [`revised-strategy-implementation-plan.md`](revised-strategy-implementation-plan.md)

## Position

> **Bivy makes coding agents on your infrastructure available from anywhere—so
> they can use your real development environment, work unattended, and remain
> understandable and under control.**

Short form:

> **Run agents where your environment lives. Reach, automate, and govern them
> from anywhere.**

Agents in environments the customer controls can use, when permitted, existing
repositories and files, local services and databases, established tools and
caches, private networks, GPUs and local models, long-running processes, and
session history. Bivy turns that capability into a dependable product through
remote access, persistence, unattended execution, automation, recovery,
approvals, checks, and governance receipts.

## Customer and progression

Start with individual power developers, technical founders, and senior engineers
already using Claude Code, Codex, or similar agents locally. They pay to make
those agents reachable away from their desks, useful across machines, able to
work unattended, recoverable after interruption, and safe enough to trust with
powerful environments.

Teams are an expansion after individual pull. They pay for shared policy, fleet
management, approver routing, budgets, evidence retention, and signed audit.

```text
Use an agent in its real environment
→ continue from anywhere
→ leave work running
→ delegate background Runs
→ automate repeatable work
→ coordinate multiple Machines
```

## Product shape

- **Sessions:** live agent work that can be steered and resumed remotely.
- **Runs:** delegated work with checks and an explicit outcome.
- **Automations:** GitHub, Linear, Slack, schedules, and webhooks that create Runs.
- **Machines:** trusted workstations or isolated environments in the customer's cloud.
- **Inbox:** questions, approvals, failures, and completed work.
- **Receipt:** what ran, where, under which protection, what Bivy observed or
  blocked, what changed, and which checks passed.

Runners, credentials, relay transport, snapshots, and audit storage support this
model; they are not separate headline products. The normative object and trust
contracts are in [`product-contract.md`](product-contract.md).

## Message hierarchy

1. **Capability:** use the environment where the real work already lives.
2. **Freedom:** choose a supported agent, model, Machine, or cloud.
3. **Reach:** continue and intervene from anywhere.
4. **Autonomy:** delegate work and leave it running.
5. **Safety:** apply boundaries, approvals, checks, and Receipts.
6. **Sovereignty:** retain control of execution, credentials, and compute.

Privacy supports the product, but capability leads the pitch.

## Execution and trust

Bivy offers three execution profiles:

- **Trusted workstation:** maximum context and capability in the user's real environment.
- **Isolated customer-cloud runner:** stronger isolation and reproducibility in the user's cloud.
- **Restricted/read-only:** narrowly scoped investigation.

Full-machine access is powerful, not inherently safe. Bivy must show what the
runtime actually enforces and what it merely observes.

Canonical trust boundary:

> **Bivy is blind on the E2E relay and a credential custodian in explicitly
> enabled hosted-provisioning paths.**

Workspace content and interactive traffic remain encrypted across the relay.
Hosted unattended provisioning may require Bivy to hold encrypted cloud,
repository, or key-escrow material that the service can technically access.
This is an explicit trust mode, not cryptographic blindness. Receipts initially
describe observed and enforced actions; “attestation” is reserved for complete,
tamper-evident, signed evidence.

## Go to market and business model

Bivy owns the end-user experience and customer relationship. Integrate with
systems that supply work—GitHub first, then Linear, Slack, CI, and project
management. Do not depend on competing coding-agent clients for distribution or
sell them Bivy's differentiating control layer.

Packaging direction, subject to customer validation:

- **Free/open front door:** basic local execution and enough remote value to
  experience the product.
- **Individual paid:** persistent remote access, unattended Runs, Automations,
  notifications, recovery, and multi-Machine coordination.
- **Team paid:** shared policy, fleet controls, approvals, budgets, retention,
  and eventually signed audit.
- **No compute markup:** customers pay infrastructure providers directly.

## Build order

1. Make connecting an existing Machine, repository, and agent effortless.
2. Make remote Sessions, reconnect, resume, stop, and approval highly reliable.
3. Let a live Session naturally become unattended work without losing context.
4. Perfect one delegated workflow: task or issue → checked changes/PR → Receipt.
5. Create one coherent Run view for progress, attention, changes, checks,
   outcome, and evidence.
6. Productize one trusted-workstation path and one isolated customer-cloud path.
7. Make execution protection and hosted custody truthful and visible.
8. Hide credential, routing, provider-lifecycle, and policy complexity behind
   sensible profiles.
9. Validate individual willingness to pay before team compliance expansion.

## Explicit non-priorities

Until the core loop retains users, do not prioritize:

- becoming a backend for competing coding-agent clients;
- a generalized workflow or DAG builder;
- compute resale or markup;
- a standalone credential/Keychain or Audit product;
- additional agents or providers without customer pull;
- warm runner pools before latency is a purchasing blocker;
- broad enterprise/compliance claims before identity, policy, retention,
  isolation, and signed audit are ready;
- architecture work that does not improve activation, remote reliability,
  delegated outcomes, or Receipts.

## Defining proof and north star

```text
Install Bivy
→ use Claude Code or Codex in a real environment
→ continue from phone
→ leave work running
→ receive checked changes or a PR
→ review a clear Receipt
```

The proof is a developer starting an agent in a real project with existing tools
or local services, leaving their desk, intervening from their phone, and later
receiving checked changes or a PR with a clear account of what Bivy observed and
enforced.

**Capability is the hook. Remote reach and unattended work are the individual
product. Governance is the seatbelt. Team control is the expansion.**
