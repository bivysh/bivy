# Cloud machines

> **Status: off by default.** A deployment turns cloud machines on with
> `EPHEMERAL_MACHINES_ENABLED=1` and a deployment extension that supplies compute
> (see [self-host.md](self-host.md#deployment-supplied-compute)).

A cloud machine is the account's "cloud computer": one Bivy node per account
that the deployment runs, which sleeps when quiet and wakes on use. To the user
it is one more place to run, shown next to their own machines (for example
"Bivy Cloud"). Prompts, files, tool output, credentials and transcripts stay on
the machine's disk. The control plane stores routing and outcome metadata, plus
a sealed session snapshot it cannot read.

People who run Bivy on their own computers and servers don't need any of this:
those machines are ordinary nodes.

## Core rule

The user brings model and repository credentials; the deployment brings compute
and orchestration. The deployment owns and pays for the machine and its
lifecycle, but never supplies or pools users' model credentials. Core launches
no machines itself and holds no provider credential.

## How a session reaches the machine

The control plane (`services/control-plane/src/cloud-computer.ts` and the
`/account/managed-machines` routes) asks the deployment extension for the
machine and answers the client with the node to connect to. It hands out no
key: the machine holds its own keys like a user-owned node, and the client
gets the room key by account pairing when it connects.

1. **Offer.** `/v1/compute/profile` says whether this account gets managed
   compute (`accountMachine: true`).
2. **Acquire.** `/v1/compute/acquire` creates or wakes the account's machine.
   A refusal is the deployment's policy decision, returned to the client as is.
3. **Boot.** The deployment calls `/internal/compute/bootstrap`. Core
   re-enrolls the account's stable node id (`eph-managed-auto-<hash>`) with a
   fresh enrollment token and returns the Fly `files` + `init.exec` that write
   `relay.json` and `start.sh` and run the daemon in the foreground. The
   payload carries no room key: the node keeps the one it generated in its
   data dir on the volume, or generates one on a new disk.
4. **Milestones.** The node reports `nodeReadyAt`, `credentialsReadyAt`,
   `repositoryReadyAt` and the first agent event for the current boot; the web
   app shows them as launch progress.

Connecting to the sleeping node, or opening one of its preview links, calls
`/v1/compute/wake`.

## Runner image

`deploy/Dockerfile.ephemeral-runner` is the build context for a
credential-free runner image (Node, Bivy, git, agent dependencies). The
deployment builds and publishes the image it boots. Enrollment and the
GitHub identity are injected at boot; the node generates its own room key, and
model credentials arrive through end-to-end vault sync or a sign-in on it. Every
bootstrap checks `command -v bivy` first and only falls back to the installer
on a generic image.

## Sleep

The bootstrap marks the node with `BIVY_EPHEMERAL=1` and
`BIVY_EPHEMERAL_SLEEP=1`. Bivy's data dir, the workspace and `HOME` live on the
volume at `/data`, so worktrees, dependency caches, agent sign-ins and
user-installed tools survive. The daemon evaluates a pure quiet condition
(`shouldSelfTeardown` in `src/ephemeral-teardown.ts`): no turn running, no
device attached, no queue work in flight, sustained past the idle window. Before
exiting it flushes a sealed snapshot of every open session, then exits; the
deployment keeps the stopped machine and its volume. The init `timeout` bounds
each awake period.

## Snapshots and a lost disk

- **Snapshot.** `src/session/snapshot.ts` seals `{records, checkpointCommit,
  bundle, runtimeSessionRef}` under the node's room key and stores it as an
  opaque blob in `session_snapshots`. The control plane sees ciphertext only.
- **Lost volume.** If the deployment destroys the machine and its volume it
  calls `/internal/compute/retired`; the node stays enrolled. Reopening a
  session calls `/account/managed-machines/restore`, which acquires a machine
  for the same node. A new disk generates a new room key and cannot open
  snapshots sealed under the old one, so the lost disk's session history is
  not restored; the bootstrap ignores a `restoreSessionId`.

## Automations

Automation routing can send queued work to the deployment's cloud, either as
the primary target or as the fallback when a chosen machine is offline. The
control plane moves the waiting work to the cloud computer's label
(`routeWorkToCloudComputer`) and acquires the machine with purpose
`"automation"`; the machine picks the work up through the hosted work queue.
Automation instructions are sealed to the machine's own room key, so saving an
automation that runs on the cloud computer first wakes it and pairs the device
with it. Runs use the model credentials the machine already holds from
end-to-end vault sync or a sign-in on it; see
[credential-sync.md](credential-sync.md).
