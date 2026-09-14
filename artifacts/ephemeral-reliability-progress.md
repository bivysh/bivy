# Ephemeral reliability follow-up to PR #678

## Branch and scope

Work is on `bivy/ephemeral-reliability-on-678`, based on PR #678 head `b4544731d6d054b287f686d70e93b3f7e4bddece`. The earlier implementation is preserved in stash `5cf64a6f971f88978d091193799f6bcfca658b42`. It has not been discarded or reapplied wholesale.

A merge with the original main-based worktree exposed substantial conflicts. This follow-up deliberately preserves #678's contracts rather than silently choosing either side of those conflicts. Integration with newer main remains necessary before merging.

## Implemented

- Stable interactive request IDs, durable replay receipts, account leases, pending-capacity reservations, and restored-node exclusivity across interactive/auth/queue paths.
- Encrypted enrollment-bearer escrow before provider effects; retries do not invalidate an already-created guest's authentication.
- Settle remote turns and observe real relay viewers before snapshot/teardown; retain fast-turn activity between timer samples.
- Preserve managed credential custody and queue/publisher privileges on rebuild.
- Reconstruct the agent's native history store from encrypted runtime/model/safety facts; preserve Bivy identity independently of native imported IDs.
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

## Authenticated live continuity

**Passed twice** with a real Fly runner and Pi / OpenAI Codex / GPT-5.5. The latest run accepted provisioning in **2.988 seconds** and attached over the encrypted relay in **36.381 seconds**. A real first reply was snapshotted, the original machine was deleted, and a different machine reopened the same Bivy session and produced a new reply recalling the marker. The follow-up prompt did not include the marker; a cached reply cannot satisfy the final assertion.

Both credential-delivery phases, encrypted snapshot, original-machine deletion, restored runtime readiness, final inventory cleanup, and provider app absence passed. See `ephemeral-continuity-live.json` and [the scope, reproduction instructions, and limitations](../docs/ephemeral-continuity-verification.md). This is portable conversation replay on an isolated local authenticated control plane, not staging/production or byte-identical native-state certification. No refresh token was copied or rotated and no billing setting was changed. Temporary services/tunnel were stopped after the probe.

## Local verification

- Core: **689 tests passed, 59 files** after enrollment-identity hardening.
- Root: **282 suites passed**, including executable safety guards for the durable live harness.
- Control plane: **42 suite scripts passed**, including admission, room-key/enrollment escrow, and 13 managed interactive orchestration tests.
- Coordinator tests: **12 passed**, including stable restore request identity.
- Root, web, and control-plane typechecks passed.
- Lint passed with zero errors (existing warnings remain).
- Module-boundary and route-uniqueness checks passed.
- No UI markup or styles were changed in this follow-up; no new visual verification is claimed.

## Still open

- The remaining milestone-reporting and image-workflow improvements from the preserved work, reconciled with #678's runtime-specific images.
- Dedicated staging/production certification; other providers/runtimes; real repository/checkpoint continuity and refresh-token rotation. Staging dev-login returned HTTP 404; the completed certification used disposable accounts on an isolated local control plane.
- Integration with newer main and final integrated regression coverage.

## Repeat the limited provider probe

Inject `FLY_API_TOKEN` directly from a secret manager; never put its value in shell history or logs. Then run:

```sh
BIVY_FLY_SMOKE=1 pnpm exec tsx scripts/smoke-ephemeral-fly.mts
```

This explicitly authorizes one short-lived paid resource. `BIVY_FLY_SMOKE_REPORT` can select an evidence path; the default is `/tmp/bivy-fly-live-evidence.json`. The report records the app/attempt identity before provisioning for manual recovery after process interruption. Normal failures still run confirmed cleanup; the guest TTL is an additional backstop, not proof of cleanup.
