# Bivy product contract

Status: canonical product vocabulary and boundary for the CLI, PWA, documentation,
and future public APIs. Implementation details may retain legacy names while they are
migrated, but they must not leak into new customer-facing surfaces.

## Position

> **Bivy makes coding agents on your infrastructure available from anywhere—so
> they can use your real development environment, work unattended, and remain
> understandable and under control.**

Short form: **Run agents where your environment lives. Reach, automate, and
govern them from anywhere.**

The message order is capability, freedom, reach, autonomy, safety, then
sovereignty. Privacy supports those claims; it is not a substitute for them.

## Customer model

Bivy has six customer-facing objects.

| Object | Contract |
| --- | --- |
| **Session** | Live agent work with durable history. A person can steer, stop, reconnect to, and resume it. |
| **Run** | Delegated work with a request, lifecycle, checks, explicit outcome, and Receipt. A Run owns or continues one Session. |
| **Automation** | A reusable trigger and instruction that creates Runs. GitHub, Linear, Slack, schedules, and webhooks are sources, not separate queue products. |
| **Machine** | A trusted workstation or isolated environment in the customer's cloud on which Sessions and Runs execute. |
| **Inbox** | The single list of questions, approvals, failures, and completed work that need a person's attention. |
| **Receipt** | A bounded report of what ran, where, under which effective protection, what Bivy observed or blocked, what changed, which checks passed, and what Bivy could not observe. |

### Relationships

```text
Automation ──creates──▶ Run ──owns/continues──▶ Session ──executes on──▶ Machine
                           │                         │
                           └──── Receipt             └──── Inbox attention
```

- A Session may exist without a Run.
- Every accepted Run has exactly one current underlying Session. A retry may
  create attempts, but does not become a second customer-visible Run.
- Every Run ends in one explicit customer outcome.
- An Automation creates Runs; it does not directly create an independent
  provider-specific job type.
- Inbox items deep-link to the exact decision or outcome, not merely a generic
  Session screen.
- A Receipt belongs to a Run. A plain Session may expose local activity history,
  but that history is not called a Receipt unless it satisfies Receipt v1.

### Run lifecycle and outcomes

The customer lifecycle is **Queued → Running/Waiting → Needs attention or
Finished**. Internal claim, lease, attempt, routing-label, and work-item states
may remain in storage and diagnostics, but are not primary navigation.

A finished Run has exactly one of:

- **PR open**;
- **Changes ready**;
- **Checks failed**;
- **Needs review**;
- **No changes**;
- **Agent failed**;
- **Timed out**;
- **Cancelled**.

A process exiting successfully is not evidence of a successful Run. Ambiguous
completion is **Needs review**.

## Execution profiles

A profile is a customer-readable promise. The UI must also show the effective
mechanisms for the selected runtime; a profile name alone is not evidence of
enforcement.

| Profile | Intended use | Minimum disclosure |
| --- | --- | --- |
| **Trusted workstation** | Maximum context and capability in the customer's real environment. | Runs with the user's OS permissions. Bivy may only observe intercepted effects; it is not an OS isolation boundary. |
| **Isolated customer-cloud runner** | Stronger isolation and reproducibility in a VM/container controlled and paid for by the customer. | Provider, image/version, machine state, TTL, estimated cost, credential-custody mode, and available protection checks. |
| **Restricted / read-only** | Investigation with no intended workspace writes and narrowly scoped access. | Which runtime or OS mechanism enforces the restriction, and every unavailable or observation-only control. |

Existing sandbox and approval settings are mechanisms inside these profiles, not
synonyms for the profiles. See [the runtime support matrix](../runtime-support-matrix.md)
and [security model](../security-model.md) for current enforcement gaps.

## Trust modes

Bivy must name the active mode wherever credentials or execution are configured.
Modes can compose; for example, a hosted-provisioned Machine can still use an
E2E relay for interactive traffic.

| Mode | Precise claim |
| --- | --- |
| **E2E relay-blind** | Interactive frames are encrypted between a Machine and paired device. The relay can observe routing metadata and can route, delay, or drop frames, but cannot decrypt their content. |
| **Hosted credential custody** | For explicitly enabled unattended provisioning, the control plane stores encrypted cloud/repository credential or key-escrow material that the service can technically access. This is not cryptographic blindness. |
| **Trusted inbound plaintext** | A third-party source such as Slack or a generic webhook sends instructions to the control plane in plaintext. The documented bounded fields may be retained for routing. |
| **Customer/device-held keys** | Relevant launch credentials or room keys remain on customer Machines/devices; provider calls may transit an allowlisted non-storing proxy as documented. |

Canonical boundary statement:

> **Bivy is blind on the E2E relay and a credential custodian in explicitly
> enabled hosted-provisioning paths.**

Detailed implementation claims live in
[the security model](../security-model.md) and
[hosted-provisioning trust model](../hosted-provisioning-trust-model.md).

## Protection language

Every Run and Receipt distinguishes:

- **Enforced** — a named mechanism blocked or constrained the action;
- **Observed** — Bivy received a trustworthy event but was not the enforcement
  boundary;
- **Unavailable** — the runtime or Machine path could not provide the signal or
  control.

Do not imply that effect-level interception is machine isolation. Do not call a
Receipt an “attestation” until it is complete, tamper-evident, and signed.

## Customer-facing language rules

Use **Machine**, **Run**, **Session**, **Automation**, **Inbox**, and **Receipt**.
Use “agent” for Claude Code, Codex, and other supported coding agents.

Keep these implementation terms out of primary customer UI and onboarding:

- work item;
- routing label;
- node (except diagnostics, CLI compatibility, and migration copy);
- ephemeral config;
- claim or lease;
- outcome report (use **Receipt** once Receipt v1 is available).

“Runner” may describe an execution process or certified image in technical
material, but the customer manages a **Machine**.

## Product boundary

Until the Session → unattended Run → checked outcome loop retains users, do not
prioritize a generalized DAG builder, compute resale, a standalone credential or
audit product, competing-client backend infrastructure, new agent/provider
breadth without customer pull, or enterprise compliance claims.

This contract changes only through an explicit product-spec update accompanied
by a PWA, CLI, documentation, API, metrics, and trust-language impact review.
