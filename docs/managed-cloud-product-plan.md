<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (c) 2026 Petter André Sjulstad
-->
# Managed Cloud product completion plan

Status: active implementation plan for [PR #678](https://github.com/bivysh/bivy/pull/678).

## Product contract

After GitHub sign-in and one model-provider sign-in, a user can pick a repository,
type a prompt, and receive an agent response without installing Bivy or choosing a
Machine/cloud provider. New messages resume recycled sessions automatically. Agent
handoffs may fork onto fresh managed compute. Personal Machines and BYO cloud remain
available under advanced settings.

## Delivery sequence

### 1. Repository-first account bootstrap

- [x] Feed every repository from the account's central GitHub App installations into
  the ordinary repository picker when no personal Machine is connected.
- [x] Add node-less branch discovery for central App repositories.
- [x] Persist an idempotent default managed compute profile after hosted onboarding.
- [x] Default the first-session surface to Repository + Agent + Prompt; keep Machine
  and provider controls in advanced/BYO settings.

### 2. Interactive managed launch

- [x] Add one account-authenticated control-plane operation that reserves policy and
  launches an interactive managed Machine using only operator-owned cloud credentials.
- [x] Return/bind the minimum E2E material required by the requesting device without
  exposing provider or GitHub credentials.
- [x] Make the first prompt the launch trigger and replay it after secure enrollment.
- [x] Render the existing provisioning milestones as quiet session progress.
- [x] Make launch denial return deployment-extension upgrade/BYO actions.

### 3. Credential and runtime generality

- [x] Describe each runtime's credential requirements in the runtime catalog.
- [x] Build provider onboarding from the live runtime provider catalog rather than
  Claude/Codex string checks.
- [x] Verify the selected runtime's testable credential before declaring onboarding
  complete.
- [x] Support multiple user-owned credentials and explicit per-item managed-reuse
  grants.

### 4. Resume and agent fork

- [x] Route an interactive message to server-side restore when its managed Machine is
  gone, including from a different signed-in device.
- [ ] Let a fork/handoff target a managed profile, provisioning the destination before
  transferring the snapshot and normalized history.
- [ ] Complete inbound issue/thread restore-and-continue.
- [ ] Certify reconstructed and native runtime-resume behavior per maintained agent.

### 5. Latency and production readiness

- [ ] Add a platform-level pool of credential-free managed runners, or prove cold start
  meets the initial prompt-to-first-token SLO without one.
- [x] Record request, provider-accepted, node-ready, credentials-ready,
  repository-ready, agent-start, and first-token timings for interactive launches.
- [ ] Live-test staging GitHub App, KMS, Fly launch/restore/teardown, and settlement.
- [ ] Add spend ceilings, provider budgets, concurrency, egress, mining/process abuse,
  and account-suspension controls before broad trial access.
- [ ] Run the full fresh-account acceptance journey on desktop and mobile without a
  CLI, personal Machine, or user cloud token.

## Merge discipline

Each slice should keep self-hosted/BYO behavior unchanged, add account-isolation and
failure-path coverage, pass the design/boundary/route guards, and land as a focused
commit on PR #678. Operator-paid launches fail closed; teardown and reconciliation
never depend on billing admission.
