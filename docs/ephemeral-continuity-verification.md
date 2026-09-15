# Authenticated ephemeral continuity verification

Draft PR [#940](https://github.com/bivysh/bivy/pull/940) consolidates #678 and its
reliability follow-up, and now targets main. The live evidence below remains
pinned to the recorded pre-integration versions; see
`artifacts/ephemeral-main-integration.md` for integrated regression coverage.
The opt-in probe is `scripts/smoke-ephemeral-continuity.mts`; the redacted live
result is `artifacts/ephemeral-continuity-live.json`.

## What passed

Two successful real Fly runs completed this sequence:

1. Publish an encrypted, access-only hosted credential grant to a disposable account.
2. Launch a managed machine; replay the same HTTP request and recover its identity.
3. Attach over the encrypted relay and confirm credential delivery.
4. Get a real Pi / OpenAI Codex / GPT-5.5 response containing a random marker.
5. Disconnect; upload the encrypted snapshot and tear down the original machine.
6. Rebuild with the same node identity and room key, but a different provider machine.
7. Reconstruct the runtime conversation, open the original Bivy session, and get a
   **new** assistant response recalling the marker without including it in the
   follow-up prompt.
8. Clear hosted inventory and independently confirm provider app absence.

The checked-in harness additionally requires the restored reply to start with
`RESTORED:` and the assistant-message count to increase. An old cached reply
cannot satisfy the assertion. It observes the first machine directly with the
operator credential before using that credential to certify deletion.

Latest run: provider accepted in **2.988 s**, encrypted attach in **36.381 s**.
Runner: `d949f1bd4a24eb05c674d726e6f77e315f69c1ff`.
Control plane: `9ad4a1d583d9324cb085b75397d040d620b7bfbb`.
These are individual samples through a temporary tunnel, not latency percentiles
or a sub-ten-second claim. Transient `Node offline` messages during boot/rebuild
were followed by successful encrypted attachment.

## Bugs the live sequence exposed

- Remote prompt activity never settled; relay viewer presence was ignored.
  Completed turns now settle, real viewers prevent teardown, and short turns
  cannot disappear between teardown samples.
- Restore omitted managed credential custody. Fresh and rebuilt runners now use
  the same purpose/source privilege policy.
- Restoring the EventLog alone did not create a resumable agent conversation.
  Snapshots now carry encrypted runtime/model/safety facts and reconstruct a native
  history store through the existing runtime-neutral import capability. Bivy's
  session identity remains stable even when the native import receives a new id.
- Review also found that retry enrollment would rotate an already-created guest's
  bearer. That bearer is now encrypted in the durable attempt before provider
  effects and reused alongside the room key. A simulated lost provider response
  verifies one enrollment and one machine creation. This fault injection is a
  **local test**, distinct from the live HTTP receipt replay.

## Limits

- This used an isolated local authenticated control plane with node-only public
  tunnel ingress, not a staging or production deployment. Staging dev-login was
  unavailable.
- This proves conversation continuity, not live repository/checkpoint recovery,
  OAuth refresh-token rotation, native Codex CLI login, every runtime, or every
  cloud provider. Checkpoint build/apply has separate local tests.
- Restoration is **portable conversation replay**, not byte-identical native
  runtime state. A missing runtime descriptor, unsupported history importer, or
  failed import is rejected rather than silently starting an empty continuation.
  Older snapshots without the descriptor retain their ciphertext/transcript but
  do not qualify as automatically resumable.
- The Anthropic access grant was delivered, but its real turn was blocked by the
  account's third-party extra-usage requirement. No billing setting was changed.
  Native Codex required a refresh grant to construct its login file; the probe did
  not copy or rotate a refresh token. GPT-5.4/mini were unavailable to this account;
  GPT-5.5 was selected after checking the account's live model catalog.
- Legacy uncertain attempts without a saved enrollment identity fail closed and
  require cleanup before a new launch; do not rotate a potentially live guest's
  authority just to make an old attempt retryable.

## Repeat safely

The probe intentionally refuses non-loopback control-plane URLs. It requires
explicit billable opt-in, an exact image commit, a selected runtime/provider/model,
a still-valid OAuth access credential, and Fly defaults capped at five minutes.
It acknowledges reduced protections only for its disposable empty workspace.

Prepare **separate, disposable** control-plane and relay processes:

- Use a minimal environment, `NODE_ENV=test`, no `DATABASE_URL`, and no production
  account database. This selects the in-memory test store. Do not inherit a
  production deployment's environment.
- Set `BIND_HOST=127.0.0.1` on both services. Without it, their deployment-compatible
  default is to listen on all interfaces. Use e.g. ports 4800 and 4801.
- Generate a temporary shared `RELAY_SECRET` and a temporary 32-byte base64
  `HOSTED_CREDENTIAL_KEY`; never print them. Enable local dev-login only on the
  disposable control plane (`DISABLE_DEV_LOGIN=0`).
- Enable `EPHEMERAL_MACHINES_ENABLED=1`,
  `MANAGED_COMPUTE_MAX_ACTIVE_PER_ACCOUNT=1`,
  `MANAGED_SESSION_TTL_MINUTES=5`, and
  `MANAGED_SESSION_SIZE=shared-2x-4gb` on that control plane.
- Set `MANAGED_SESSION_IMAGE` to the published `prebuild-<commit>` runner image.
  `PUBLIC_CONTROL_PLANE_URL` points to your HTTPS gateway and `RELAY_PUBLIC_URL`
  to its `wss://…/relay` path. The relay's `CONTROL_PLANE_URL` is loopback.
- Expose **only** node ingress through the temporary gateway: `/nodes/enroll`,
  `/node`, `/node/*`, and authenticated `/internal/nodes/*`. Forward WebSocket
  `/relay/node` and `/relay/client` to the relay after stripping `/relay`.
  All other public routes, especially `/auth/dev-login` and `/account/*`, must
  return 404. Never tunnel the dev-login-enabled control plane directly.
- Inject `MANAGED_PROVIDER_TOKEN_FLY` from the same secret-manager reference into
  the control plane and probe. Do not paste its value or use a different cached
  Fly CLI login. Keep service logs private.

Run from the repository root, with that operator credential already injected:

```sh
BIVY_CONTINUITY=1 \
BIVY_CONTINUITY_CONTROL_PLANE_URL=http://127.0.0.1:4800 \
BIVY_CONTINUITY_PUBLIC_URL=https://YOUR-NODE-ONLY-GATEWAY \
BIVY_CONTINUITY_RUNTIME=pi \
BIVY_CONTINUITY_PROVIDER=openai-codex \
BIVY_CONTINUITY_MODEL=gpt-5.5 \
BIVY_CONTINUITY_IMAGE_COMMIT=YOUR_40_CHARACTER_RUNNER_COMMIT \
BIVY_CONTINUITY_CONTROL_PLANE_COMMIT=YOUR_CONTROL_PLANE_COMMIT \
pnpm exec tsx scripts/smoke-ephemeral-continuity.mts
```

Select an account-supported model; the runner's static catalog alone is not proof
of account entitlement. Optional `BIVY_CONTINUITY_CREDENTIAL_DIR` and
`BIVY_CONTINUITY_CREDENTIAL` select the vault/record explicitly; defaults are
`~/.bivy/credentials` and the selected provider's default record. The source vault
is read only. `BIVY_CONTINUITY_REPORT` selects the redacted output path.

Normal failures run cleanup and cannot report `passed: true` unless both inventory
and provider absence checks pass. A killed process cannot run `finally`: use the
app/machine identifiers written before/after launch to perform recovery with the
same operator credential. Guest TTL is a backstop, not proof of provider absence.
Stop the disposable services and tunnel afterwards; this also discards the
in-memory account and copied grant. Remove temporary private logs and references,
but never delete the user's original credential vault.
