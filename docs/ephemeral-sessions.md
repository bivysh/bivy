# Cloud machines

> **Status: off by default.** A deployment turns cloud machines on with
> `EPHEMERAL_MACHINES_ENABLED=1` and a deployment extension that supplies compute
> (see [self-host.md](self-host.md#deployment-supplied-compute)). Setting the flag
> to exact `0` stops new launches; cleanup and reconciliation keep running so the
> switch can never strand a billable machine.

A cloud machine is a short-lived Bivy node the deployment launches for a
session or an automation run. To the user it is one more place to run, shown
next to their own machines (for example "Bivy Cloud"). Prompts, files, tool
output, credentials and transcripts stay on the machine and are destroyed with
it unless exported as a branch, PR or artifact. The control plane stores routing
and outcome metadata, plus a sealed session snapshot it cannot read.

People who run Bivy on their own computers and servers don't need any of this:
those machines are ordinary nodes.

## Core rule

The user brings model and repository credentials; the deployment brings compute
and orchestration. The deployment supplies the cloud credential and launch
profile and pays for the machines, but never supplies or pools users' model
credentials. Bivy does not launch machines in a user's own cloud account.

## How a launch works

All provisioning runs in the control plane
(`services/control-plane/src/ephemeral-provisioner.ts`), driven by the provider
adapters in `packages/core/src/ephemeral-providers/` (Fly Machines today).

1. **Profile and credential.** The control plane asks the deployment extension
   for the launch profile (provider, region, size, image, TTL) and the provider
   credential (`/v1/compute/profile`, `/v1/compute/credential`). The credential
   is held in memory only.
2. **Admission.** `/v1/policy/check` with `operation: "ephemeral.provision"` and
   technical facts only (compute source, size, TTL, purpose,
   `activeManagedMachines`). The deployment enforces plans and limits.
3. **Durable attempt.** The launch is recorded before any side effect, inside a
   per-account lease, so retries and replicas never buy a second machine.
4. **Enroll and boot.** A fresh node id is enrolled, a room key is minted and
   escrowed (sealed with the account's hosted key), and the adapter creates the
   machine with a bootstrap carrying `relay.json` and `start.sh`. The node boots,
   dials out to the relay, and the user's device reaches it end-to-end.
5. **Milestones.** The node reports `nodeReadyAt`, `credentialsReadyAt`,
   `repositoryReadyAt` and the first agent event; the web app shows them as
   launch progress.

Every provider request goes through the host allowlist (`ALLOWED_HOSTS` in
`packages/core/src/ephemeral-provider-utils.ts`) — the SSRF guard.

## Runner image

Cold starts use the credential-free image built by
`deploy/Dockerfile.ephemeral-runner` and published as
`ghcr.io/bivysh/bivy-ephemeral-runner:sha-<commit>` (and `:main`) by
`.github/workflows/ephemeral-runner-image.yml`, with `-claude`, `-codex` and
`-pi` variants so a launch doesn't pull other agents' binaries. The image holds
only public material (Node, Bivy, git, agent dependencies); enrollment, room
keys, credentials, repository and restore state are injected at launch. The
GHCR package must be public. Every bootstrap checks `command -v bivy` first and
only falls back to the installer on a generic image, so a deployment should name
a prebuilt image in its profile. Cold start is measured from request to the
first agent event.

## Teardown

Teardown authority lives on the machine and in the control plane, so it works
with no device online:

- **The daemon ends the machine when idle.** The bootstrap marks it with
  `BIVY_EPHEMERAL=1` (plus provider, TTL and `BIVY_TEARDOWN_ON_FINISH`). The
  daemon evaluates a pure quiet condition (`shouldSelfTeardown` in
  `src/ephemeral-teardown.ts`): no turn running, no device attached, no queue
  work in flight, sustained past a grace — short after an agent finishes, else
  the idle window — and only once the machine has been busy. Before exiting it
  flushes a sealed snapshot of every open session and stays up if that fails.
- **Fly reaps on exit.** The daemon is the machine's foreground init process;
  `auto_destroy` deletes the machine when it exits. The TTL `timeout` around the
  init process is the hard backstop.
- **The control plane is the backstop.** A timer reconciles every account with a
  tracked machine or launch attempt every five minutes: it deletes machines past
  their TTL or boot deadline, confirms deletion with a fresh status read, retries
  failures, and sweeps orphaned provider resources tagged for the account.
  Cleanup ignores the launch kill switch, and a credential the extension already
  supplied keeps working through an extension outage.

## Sessions outlive machines

The control plane never holds readable session state, so continuity comes from
an encrypted snapshot plus git:

- **Snapshot.** `src/session/snapshot.ts` seals `{records, checkpointCommit,
  bundle, runtimeSessionRef}` under the node's room key and stores it as an
  opaque blob in `session_snapshots`. The control plane sees ciphertext only.
- **Correlation.** A durable session↔machine record (`session_correlation`,
  not cascaded off nodes) survives teardown, so the session stays in the sidebar
  and its composer stays enabled.
- **The message is the trigger.** Sending into a session whose machine was
  retired calls `/account/managed-machines/restore`, which launches a new machine
  with the same node id and the escrowed room key and `BIVY_RESTORE=<sessionId>`.
  The daemon restores the transcript and git checkpoint before anything else
  starts, then the buffered prompt is delivered. No "rebuild" button.
- **Fidelity.** The transcript and working tree are restored; the agent's native
  runtime process starts fresh, seeded from the restored history.

### Sleeping machines (experimental)

A machine can sleep instead of being destroyed. With `BootstrapOpts.sleepOnIdle`
(and `ProviderProvisionConfig.persistentDiskGb`), the Fly adapter creates one
encrypted volume per app (`bivy_data`), mounts it at `/data`, and launches the
machine with `auto_destroy: false`. Bivy's data dir, the workspace and `HOME`
live on the volume, so worktrees, dependency caches, agent sign-ins and
user-installed tools survive. When the daemon's quiet condition passes it exits
**without** `POST /node/settled`, and Fly keeps the stopped machine. A machine
woken for nothing sleeps again after the idle window instead of running to its
TTL. `ProviderAdapter.wake` starts it again; its presence is the provider's
sleep capability. `destroy` removes the volume together with the app.

The TTL bounds each awake period (the init `timeout`), not the machine's
lifetime. Nothing launches sleeping machines yet. Before anything does, the
control-plane reconciler has to stop expiring them by `createdAt + TTL`, and
something has to call `wake` when traffic arrives for a sleeping node.
`scripts/smoke-fly-sleep-wake.mts` measures stop/suspend → healthy latency and
volume persistence against a real Fly account (opt-in, paid).

## Metering

Core records provider-neutral lifecycle facts from server-stamped milestones.
`machineSeconds` runs from provider launch until the machine is confirmed gone;
`activeAgentSeconds` starts at the first agent event. Both are reported to the
deployment extension with `ephemeral.settled`. Core contains no plans, prices or
caps; settlement is idempotent across teardown retries and never depends on
admission.

## Automations

Automation routing can send queued work to the deployment's cloud, either as
the primary target or as the fallback when a chosen machine is offline. The
control plane plans the launch (`planAutoProvision`), routes the waiting work to
the new machine's unique label, and the machine picks it up through the hosted
work queue. Unattended runs use the separately encrypted credential copy the user
opted into ("Allow unattended runs"); see [credential-sync.md](credential-sync.md).

## Adding a provider

A provider is one `ProviderAdapter` in `packages/core/src/ephemeral-providers/`
plus one row each in the registry (`ephemeral-provider-registry.ts`), the catalog
(`ephemeral-catalog.ts`) and the host allowlist. The adapter implements
`provision`, `status`, `destroy`, `discover` and `cleanupAttempt` against the
`ExecFn` it is given, normalizes the provider's status strings to `starting |
running | stopped | gone`, and must guarantee that its teardown path deletes the
billable resource. Test it against a fake `ExecFn` (see
`packages/core/test/ephemeral-fly.test.ts`).
