# Ephemeral strategy audit — 2026-08-12

**Scope:** PRs #488–#499 and current working-tree corrections, audited against
[Phase 5 of the revised strategy implementation plan](revised-strategy-implementation-plan.md).

## Verdict

Phase 5 is **partial, not certified**. The series adds useful hosted-Machine
management, routing correctness, cross-replica serialization, a
credential-gated live-smoke harness, lifecycle/cost evidence, hosted GitHub App
minting, and safer lifecycle reconciliation. It does not provide the live
measurements, provider selection, certified image, complete pre-claim readiness
contract, or sustained leak evidence required by the gate.
Unit tests are evidence of control-path behavior, not evidence that a provider
resource was created or destroyed.

## PR/current-code audit

| Change | Phase 5 evidence | Status | Remaining concern |
| --- | --- | --- | --- |
| #488 hosted management API | Hosted settings/config and machine inventory are exposed through account APIs. | Partial | Inventory is not yet a complete authoritative state model and API presence is not provider certification. |
| #489 hosted management UI | Users can enable hosted provisioning, manage credentials, and see/destroy tracked runners. | Partial | Failure/recovery presentation does not yet prove that every resource is visibly live, absent, or unresolved. |
| #490 provider boundary | Catalog metadata distinguishes BYO-cloud from experimental managed compute and documentation keeps portability explicit. | Done for boundary only | It does not select or certify the one raw-VM Phase 5 provider. |
| #491 live smoke | A protected, credential-gated workflow covers provision → first agent event → destroy and checks empty hosted inventory; cleanup is unconditional. | Partial / unverified | No credentialed run evidence, continuous schedule, snapshot/restore exercise, percentile publication, alerting, or leaked-resource history is present. |
| #492 hosted routing | Claimed work is retargeted to the newly provisioned runner label; a regression test covers the route. | Done for routing control | Provider execution remains unverified live. |
| #493 provisioning lease | A Postgres account lease serializes provisioning across replicas; a concurrency test covers duplicate-launch prevention. | Done for lease control | Store/unit behavior does not establish provider-side idempotency under real failures. |
| #494 ready capacity | Account-isolated standby creation, atomic claim, replenishment, expiry handling, and lease interaction have unit coverage. | Experimental, outside milestone | See the strategy conflict below. It also adds idle-cost and lifecycle surface before demand is established. |
| #496 lifecycle and cost evidence | Hosted inventory derives durable provisioning/hydrating/ready/claimed/working phases, promotes teardown/reconcile failures, and shows TTL plus estimated accrued/max compute cost. | Partial, material progress | The phases are Bivy-observed metadata, not provider-confirmed liveness/absence; estimates are not bills; recovery remains incomplete. |
| #499 hosted GitHub App minting | A phone-only hosted path can configure an App and mint short-lived installation credentials without a persistent Machine or long-lived PAT on the runner. | Done for repository credential path | It does not validate clone/push/PR access before claim or prove the full workflow live. Hosted custody must remain explicit. |
| Current teardown correction | A settled hosted Machine is retained and audited as `reconcile_failed` when provider credentials are unavailable; restoring credentials can permit a later retry. The regression test is in `test:unit`. | Done for this correctness case | Other destroy failures and provider ambiguity still need an explicit authoritative unresolved-state UX and live recovery proof. |
| Current test manifest correction | Hosted routing, provision-lease, and ready-capacity suites are included in control-plane `test:unit`. | Done | CI execution validates deterministic paths only. |

## Phase 5 checklist assessment

- **Provider selection — unverified.** Multiple raw-VM adapters remain available;
  there are no measured live reliability results selecting one.
- **Certified image — partial.** A versioned GHCR runner-image workflow and
  credential-free injection model exist, but no published certification record
  demonstrates the required tools and readiness probes on one selected provider.
- **Authoritative Machine lifecycle — partial.** Inventory, durable lifecycle
  phases, TTL reconciliation, settled teardown, global sweeping, audit events,
  teardown-failure presentation, and missing-credential retention materially
  improve safety. The code still lacks provider-confirmed live/absent/unresolved
  states and recovery for every failure mode.
- **Pre-claim readiness — partial.** Routing waits for Machine availability, the
  smoke observes a first agent event, and hosted GitHub Apps can mint short-lived
  repository credentials without a persistent Machine. There is still no
  complete pre-claim check for agent/version, usable model credential, actual
  clone/push access, and effective protection.
- **Pre-launch disclosure — partial.** Provider, region/size, TTL, indicative
  max/accrued cost, teardown behavior, and hosted credential controls exist
  across the UI. Image identity and one consolidated custody disclosure are not
  established for every launch path.
- **Delete recovery — partial.** Failed and credential-blocked deletion retains
  the Machine; manual destroy exists. Explicit unresolved status, emergency
  recovery guidance, and live credential-restore/retry evidence remain missing.
- **Continuous lifecycle exercise — unverified.** The workflow is manual and
  credential-gated and does not cover snapshot/restore or demonstrate alerts.
- **Published operations evidence — not done.** No sustained cold-start/teardown
  percentiles or leaked-resource count were found.

## Ready-capacity strategy conflict

Ready capacity conflicts with the revised strategy's explicit **warm-pool
non-priority**: it deliberately pays for an idle runner and expands fleet
coordination before the product has measured a latency problem. It must remain
**experimental and must not count as a Phase 5 strategy milestone** until measured
customer latency demand exists and shows that cold start materially blocks
successful Runs. Any continuation should be gated by observed cold-start
percentiles, abandonment/failure data, an explicit idle-cost budget, and proof
that provider-native fast-start or suspend paths are insufficient.

## Risks

1. **False absence / leaked spend:** losing credentials or receiving ambiguous
   provider errors can outlive local records unless every path retains an
   unresolved Machine. The current correction closes one important case.
2. **Control-plane concurrency:** the Postgres lease reduces duplicate launches,
   but crashes around provider create/record persistence still require live
   reconciliation and provider-side identification.
3. **Readiness mismatch:** “node online” can precede usable model credentials,
   repository access, compatible runtime, or required protection.
4. **Smoke overclaim:** an available manual workflow can be mistaken for a
   passing certification program when no credentialed run artifacts or trend
   data are published.
5. **Ready-capacity cost and scope:** standby replenishment can increase idle
   cost and leak surface while distracting from the persistent-Machine and
   isolated-runner reliability gates.
6. **Provider breadth:** maintaining several experimental substrates makes it
   harder to establish one supportable, measured raw-VM path.

## Evidence required to close Phase 5

Select one raw-VM provider from recorded live results; publish and verify one
versioned image; implement the complete pre-claim readiness contract and
user-visible unresolved state/recovery path; then run scheduled credentialed
provision → ready → execute → snapshot → restore → destroy tests long enough to
publish cold-start and teardown percentiles with a zero-leak/unresolved-resource
accounting. Until then, the Phase 5 gate remains open.
