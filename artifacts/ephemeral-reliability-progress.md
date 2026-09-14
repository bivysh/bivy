# Ephemeral reliability follow-up to PR #678

## Branch and scope

Work is on `bivy/ephemeral-reliability-on-678`, based on PR #678 head `b4544731d6d054b287f686d70e93b3f7e4bddece`. The earlier implementation is preserved in stash `5cf64a6f971f88978d091193799f6bcfca658b42`. It has not been discarded or reapplied wholesale.

A merge with the original main-based worktree exposed substantial conflicts. This follow-up deliberately preserves #678's contracts rather than silently choosing either side of those conflicts. Integration with newer main remains necessary before merging.

## Implemented

- Room-key escrow before provider creation; reload the original key on hosted retry.
- Recover retries from durable launch intent, including billing source and finish policy, rather than an edited profile.
- Provider-only deletion; retain tracking and node authority until authoritative absence, including legacy records.
- Preserve old unresolved machines when adding inventory; age alone no longer removes them.
- Keep overdue, stopped, and failed managed resources in the concurrency count until deletion is observed.
- Bounded Fly bootstrap, restrictive bootstrap-file permissions, and pinned prebuilt default.
- Fly attempt adoption with validated inventory and safe empty-app cleanup.
- Handle Fly's real HTTP 422 existing-name response without swallowing unrelated validation failures.

## Live provider evidence

The successful probe's raw result is `ephemeral-fly-live.json` alongside this report.

- Region/size: Fly `iad`, two shared CPUs, 4 GB RAM, five-minute guest TTL.
- Published image: `ghcr.io/bivysh/bivy-ephemeral-runner@sha256:30705bdda88425646b0c5dc19fc0e95cc4a026ca9c09a4f904c15b3a21e246ac`.
- Provider accepted creation in **2.642 seconds**.
- Actual packaged daemon health and native PTY check passed by **31.105 seconds** from provisioning start.
- Retrying adopted the **same machine**; inventory contained exactly one machine.
- Machine and dedicated app deletion were confirmed.

Earlier probe attempts exposed harness mistakes (Fly's exec request uses a string `cmd`, and the default daemon port is 4317). After those corrections, the probe found the actual adapter's 422 retry bug. All five probe apps were confirmed deleted, including failed probes. Intermediate `lastExecExit: 1` in the successful report records polling before the daemon became ready, not a final failure.

This used an intentionally unregistered bootstrap and an already-published image. It does **not** certify account enrollment, credential handoff, model execution, the PR's newly built/runtime-specific images, or snapshot/restore. The timing is a single polled sample, not a cold-start percentile or sub-10-second guarantee.

## Local verification

- Ephemeral core plus account API: **166 tests passed, 20 files** after the idempotency increment.
- Control plane: **41 suite scripts passed**, including admission, room-key escrow, and 13 managed interactive orchestration tests.
- Coordinator tests: **12 passed**, including stable restore request identity.
- Root, web, and control-plane typechecks passed.
- Lint passed with zero errors (existing warnings remain).
- Module-boundary and route-uniqueness checks passed.
- No UI markup or styles were changed in this follow-up; no new visual verification is claimed.

## Still open

- Completed in the next increment: stable interactive request IDs, durable replay receipts, per-account lease serialization, pending-capacity reservations, and restored-node exclusivity. Auth runners and queue recovery share the same lease. Thirteen dedicated orchestration tests cover replay/conflict, capacity, failure, lease loss, lifecycle persistence, and concurrent restore/reconciliation.
- The remaining milestone-reporting and image-workflow improvements from the preserved work, reconciled with #678's runtime-specific images.
- Full authenticated message → snapshot → teardown → rebuild → message certification. Dedicated staging dev-login returned HTTP 404; no authenticated test account was created.
- Integration with newer main and final integrated regression coverage.

## Repeat the limited provider probe

Inject `FLY_API_TOKEN` directly from a secret manager; never put its value in shell history or logs. Then run:

```sh
BIVY_FLY_SMOKE=1 pnpm exec tsx scripts/smoke-ephemeral-fly.mts
```

This explicitly authorizes one short-lived paid resource. `BIVY_FLY_SMOKE_REPORT` can select an evidence path; the default is `/tmp/bivy-fly-live-evidence.json`. The report records the app/attempt identity before provisioning for manual recovery after process interruption. Normal failures still run confirmed cleanup; the guest TTL is an additional backstop, not proof of cleanup.
