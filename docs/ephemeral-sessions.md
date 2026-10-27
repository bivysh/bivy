# Cloud machines

> **Status: off by default.** A deployment turns cloud machines on with
> `EPHEMERAL_MACHINES_ENABLED=1` and a compute service: Bivy's own
> [fleet](#run-the-fleet-yourself), or an operator's own
> ([self-host.md](self-host.md#deployment-supplied-compute)).

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
lifecycle, but never supplies or pools users' model credentials. The control
plane launches no machines itself and holds no provider credential: one service,
the fleet, holds that one secret.

## How a session reaches the machine

The control plane (`services/control-plane/src/cloud-computer.ts` and the
`/account/managed-machines` routes) asks the compute service for the machine
and answers the client with the node to connect to. It hands out no
key: the machine holds its own keys like a user-owned node, and the client
gets the room key by account pairing when it connects.

1. **Offer.** `/v1/compute/profile` says whether this account gets managed
   compute (`accountMachine: true`).
2. **Acquire.** `/v1/compute/acquire` creates or wakes the account's machine.
   A refusal is the deployment's policy decision, returned to the client as is.
3. **Boot.** The fleet calls `/internal/compute/bootstrap`. Core
   re-enrolls the account's stable node id (`eph-managed-auto-<hash>`) with a
   fresh enrollment token and returns the Fly `files` + `init.exec` that write
   `relay.json` and `start.sh` and run the daemon in the foreground. The
   payload carries no room key: the node keeps the one it generated in its
   data dir on the volume, or generates one on a new disk.
4. **Milestones.** The node reports `nodeReadyAt`, `credentialsReadyAt`,
   `repositoryReadyAt` and the first agent event for the current boot; the web
   app shows them as launch progress.

Connecting to the sleeping node, or opening one of its preview links, calls
`/v1/compute/wake`. So does someone who works on it being present in the app
(`POST /account/cloud-computer/presence`): opening it, returning to it, or
focusing the composer, so the machine is up before the first message. The first
real use of each boot (an agent turn or an opened terminal) is reported to the
deployment as `/v1/compute/used`.

## Run the fleet yourself

`services/fleet` is the open implementation of everything above: it creates,
wakes, meters, guards and deletes the machines. Point the control plane at it
and the whole stack — app, control plane, relay and cloud machines — runs on
infrastructure you control.

Three decisions, then four settings:

1. **A provider account.** Today the fleet speaks Fly Machines
   (`services/fleet/src/fly.ts`); a new provider is one adapter plus a row in
   `PROVIDERS`. Use a token scoped to **one organization** that holds nothing
   else: the fleet creates an app per account in it, and sweeps apps in it that
   no account owns.
2. **A machine image.** Build `deploy/Dockerfile.ephemeral-runner` and push it
   somewhere the provider can pull from. A generic image installs Bivy at boot
   and misses the startup budget, so the fleet refuses to launch without one.
3. **How much any one account may use.** The fleet applies its own caps with no
   further service — `FLEET_MONTHLY_HOURS`, `FLEET_MAX_MACHINES`,
   `FLEET_MAX_RUNNERS_PER_ACCOUNT`. Leave them at 0 for a fleet only you use;
   set them before you hand machines to anyone else.

```sh
# deploy/.env
DEPLOYMENT_COMPUTE_URL=http://fleet:4600
DEPLOYMENT_COMPUTE_TOKEN=$(openssl rand -hex 32)
EPHEMERAL_MACHINES_ENABLED=1
FLEET_PROVIDER_TOKEN_FLY=…
FLEET_IMAGE=registry.example.com/bivy-runner:2026-10-27
FLEET_GUEST_HARDENING_ATTESTED=1

docker compose -f deploy/docker-compose.yml --env-file deploy/.env \
  --profile fleet up -d
```

Taking over machines another fleet created (a migration, or a restore from
somewhere else) needs `FLEET_SWEEP_ORPHANS=0` until the records are in the
fleet's own tables: it deletes apps in its fleet that no record owns, so an
empty store otherwise reads as litter. Turn it back on once the counts match.

`GET /readyz` on the fleet reports `offered` and, when it is withholding
launches, exactly what is missing. Every setting is listed in
[services/fleet/README.md](../services/fleet/README.md).

What the fleet decides, and what Core decides, is the split in the table there:
the fleet owns the machine, Core owns the node's identity, the boot payload and
the relationship with the person — including the notice before an idle machine
and its disk are deleted, which the fleet asks Core to send
(`/internal/compute/notice`).

### Selling machine time

The fleet meters awake time itself and reports it per account at
`/v1/compute/usage`, in Standard seconds (a bigger size costs more of them, by
the `weight` column in `services/fleet/src/sizes.ts`). That is what an invoice
is built from.

An operator who charges for it points `FLEET_POLICY_URL` at a service of their
own, which answers `/v1/policy/check` and optionally
`/v1/policy/compute/limits`, `/v1/policy/compute/runs` and
`/v1/policy/compute/disk`. Both sets of answers apply: a policy service lowers
a ceiling per account and can never raise the deployment's own. Plans, prices
and tiers live in that service.

## Runner image

`deploy/Dockerfile.ephemeral-runner` is the build context for a
credential-free runner image (Node, Bivy, git, agent dependencies). The
deployment builds and publishes the image it boots (`FLEET_IMAGE`). Enrollment and the
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
fleet keeps the stopped machine and its volume, and deletes it only after
`FLEET_IDLE_DELETE_DAYS` asleep with the account warned first. The init `timeout` bounds
each awake period.

## Session runners

When the deployment offers runners, the machine picker also lists "Cloud
Runner": a new machine for one session instead of the shared cloud computer.
It boots like a runner for queued work, but sleeps when quiet instead of
ending, with its sessions on its own disk. The fleet runs these when
`FLEET_RUNNERS=1`. Connecting to it or sending to its
session wakes it. The deployment deletes one that has slept too long; the app
shows that date above the composer, and deleting the runner's only session
deletes the runner.

## Snapshots and a lost disk

- **Snapshot.** `src/session/snapshot.ts` seals `{records, checkpointCommit,
  bundle, runtimeSessionRef}` under the node's room key and stores it as an
  opaque blob in `session_snapshots`. The control plane sees ciphertext only.
- **Lost volume.** When the fleet destroys the machine and its volume it
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
