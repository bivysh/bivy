# PR #678: ephemeral reliability review

Reviewed head: `b4544731d6d054b287f686d70e93b3f7e4bddece`.
Scope: managed launch, credential selection, retry, restore, teardown, admission, and runner packaging. This is not a complete review of the PR's KMS, GitHub App, or OAuth work.

## Conclusion

Build on #678 rather than introduce another managed-compute implementation. It already provides the broader product path: first-prompt managed launch, authentication on the intended runner, encrypted credential publication, fresh-device key adoption, message-triggered restore, managed forks, deployment-owned policy/metering hooks, and runtime-specific prebuilt images.

The current session's overlapping managed API/UI should not be merged alongside it unchanged. In particular, #678 uses `computeSource: user | managed`, `MANAGED_PROVIDER_TOKEN_<PROVIDER>`, `MANAGED_COMPUTE_ENABLED`, and `/account/managed-machines` routes. This session introduced different names and a separate preview admission scheme. Preserve #678's public contracts and deployment-policy boundary; port the independent reliability fixes and tests.

## Findings

Line numbers below refer to the reviewed PR head, not the current worktree.

### P1 — Persist room keys before any provider create

`services/control-plane/src/ephemeral-provisioner.ts:598–674, 1131`

The generated room key is retained in memory while `launcher` creates the resource. Escrow happens only after the launcher returns and subsequent bookkeeping succeeds. A lost create response or process crash can therefore leave a real machine whose key was never saved. The reconciliation retry passes attempt/node identity but not the original key.

Persist the encrypted key before provisioning, fail before provider mutation if persistence fails, and reload that same key on retries. Test accepted-create/lost-response and crash-before-tracking cases. The session's `persistRoomKey` launch dependency is suitable for porting.

### P1 — Reconstruct retries from the durable attempt, not a mutable profile

`services/control-plane/src/ephemeral-provisioner.ts:1109–1131`

The retry first selects the current saved config; persisted `desired` facts are used only if the config was deleted. Editing that profile can change provider, size, image, or billing source during recovery. The managed kill-switch check uses the old attempt's source, while the actual launch resolves credentials from the newly selected config.

Always reconstruct the original launch intent from the attempt, including credential lane and finish policy. Apply current authorization separately; never silently reinterpret an existing paid operation as a different launch.

### P1 — Interactive launch/restore lack stable request identity and serialization

`services/control-plane/src/index.ts:1413–1499`

Both routes generate a new attempt UUID for each HTTP request. Neither route takes the provisioner's account lease or checks for an already-active operation for the same restored node. Concurrent restore requests can both reach provisioning with the same node identity; retrying a lost launch response creates another logical purchase instead of recovering the first.

Carry a client-persisted request identity, serialize admission with durable attempts, and return/recover the existing operation on retry. A deployment spending decision does not itself provide node-identity idempotency. Test concurrent requests and lost HTTP responses.

### P1 — Bookkeeping is removed before provider-confirmed deletion

`services/control-plane/src/ephemeral-provisioner.ts:903–920, 983–1010`; `packages/core/src/ephemeral.ts:360–386`

The hosted deletion wrapper calls the ordinary core destroy function. That function removes the machine record and deregisters the node immediately after the provider accepts deletion. Only afterward does the hosted caller check whether the resource is actually gone. A surviving attempt can allow later recovery, but this still prematurely removes live-resource visibility and node authority; legacy records lack that recovery path.

Use provider-only deletion, retaining machine/node bookkeeping until an authoritative `gone` observation. The session's `providerOnly` change addresses this seam. Also port removal of the six-hour inventory filter in `serverMachineStore.add` (`ephemeral-provisioner.ts:493`): resource age is not proof of deletion.

### P2 — The last-resort concurrency ceiling stops counting live resources at TTL

`services/control-plane/src/managed-admission.ts:13–19`; `services/control-plane/src/index.ts:157–160`

A machine explicitly marked `running` is excluded once its planned TTL has elapsed, even if teardown failed and it remains billable. Direct execution of the PR helper reproduced this: a five-minute-TTL machine still running at minute six contributes **0**, not 1. Pending creates are also absent from this inventory-only count.

Count unresolved live resources and in-flight reservations until authoritative termination. Keep the check/reservation atomic; retain deployment billing policy as an additional control.

## Verification and limits

- GitHub reports the reviewed PR's checks passing, including control-plane, root, browser, and `ci-ok` checks.
- Independently reproduced the expired-TTL concurrency undercount using the PR's actual helper.
- Reviewed the other findings by tracing implementation paths; did not independently rerun the entire PR suite.
- Current worktree ephemeral regression suite: **115 tests passed across 19 files**. These results do not certify the PR branch.
- Fly authentication now works through masked Proton Pass injection. No Fly resource was created during this review.
- Dedicated staging test-account login returned HTTP 404. Full authenticated launch → agent → snapshot → rebuild certification remains unperformed.

## Integration direction

1. Preserve this worktree before changing its base; do not discard either implementation blindly.
2. Use #678's managed contracts, onboarding, credential handoff, and billing-extension integration.
3. Port the crash-safe key escrow, immutable retry intent, provider-confirmed cleanup, bounded bootstrap/milestone reporting, and associated regression tests.
4. Resolve image-workflow changes against #678's runtime-specific variants, rather than replacing them with a single-image pipeline.
5. Run integrated unit/browser checks and isolated live provider tests, then certify the full authenticated continuity path on a dedicated account.
