# Ephemeral machine lifecycle review

> Review date: 2026-08-13. This is an implementation review and an open-source
> landscape survey, not a claim that every provider integration has been live-tested.

## Executive summary

Bivy has the right product-level split: a portable `ProviderAdapter`, a fast
prebuilt runner image, provider-native expiry where available, in-guest idle
teardown, control-plane reconciliation for hosted runners, and encrypted session
snapshots for rebuild. The design is stronger than a simple “create VM, run a
script, delete VM” implementation.

The weak point is the **controller lifecycle around provider side effects**. A
launch is not yet a durable, recoverable state machine. Enrollment, provider
creation, and machine tracking happen sequentially; a crash or timeout between
them can leave either an orphaned node or an untracked, billable machine. Hosted
machine records are JSON arrays rewritten wholesale, the lease is fixed rather
than renewed, and reconciliation mostly acts at settlement/TTL rather than
converging desired and observed provider state throughout the lifecycle.

No surveyed project is a drop-in replacement for Bivy's unusual combination of
browser-held credentials, E2E relay pairing, interactive sessions, and hosted
rebuild. The useful plug-and-play pieces are narrower:

1. **Keep Bivy's provider adapters and session plane.** Do not replace them with
   Terraform/OpenTofu, DevPod, ARC, or GitLab Runner.
2. **Use `coder/envbuilder` optionally as a bootstrap payload** when Bivy adds
   devcontainer-defined repository environments. It is not a machine controller.
3. **Evaluate Daytona as another managed sandbox adapter only**, with an explicit
   license/API review. Its old self-hosted release is public but current Daytona
   is not a safe assumption for an OSS dependency.
4. **Borrow the controller patterns from Kubernetes operators, GitHub ARC, and
   GitLab Runner's fleeting/taskscaler stack:** durable desired/observed state,
   provider discovery by ownership tag, idempotent create, renewable ownership,
   startup deadlines, and finalizers that retain a record until deletion is
   confirmed.

The highest-priority fix is a durable `machine_attempts` record written **before**
a provider create call, plus provider tags/idempotency keys and a reconciler that
can discover and delete resources even if the create response was lost.

## Lifecycle as implemented

### Device-driven lane

1. The device validates and stores a provider token locally.
2. `launchEphemeralMachine` enrolls an `eph-*` node and creates a room key.
3. The selected adapter creates a Fly Machine, Hetzner server, EC2 instance,
   Sprite, or E2B sandbox.
4. Cloud-init or provider-native init writes relay configuration and starts
   `bivy start`. A prebuilt image can skip installation.
5. The node joins the relay; model credentials hydrate over the E2E path.
6. Destroy-lane machines exit after a quiet condition and snapshot flush;
   suspend-lane machines are retained and woken later.
7. Device teardown calls the provider and then removes the machine record and
   node. Device records and provider credentials are local, with optional E2E
   device-vault token sync.

### Hosted lane

1. A queue event calls `maybeAutoProvision`.
2. Planning checks account opt-in, routing, validated credentials, node
   liveness, active capacity, and an hourly launch cap.
3. A per-account provision lease serializes plan/claim/create.
4. The control plane calls the same core launcher with hosted credentials and
   persists the result in hosted machine inventory.
5. Ready capacity may be claimed and replenished.
6. The runner snapshots sessions before self-teardown and calls `/node/settled`.
7. A five-minute global sweep reconciles all tracked hosted machines; deletion
   failures or missing credentials retain the record for retry.
8. A later targeted message can rebuild with the old node id, escrowed room key,
   and encrypted snapshot.

### Existing strengths worth keeping

- Provider details are isolated behind `ProviderAdapter`.
- Fly `auto_destroy` and EC2 instance-initiated termination provide real
  provider-native backstops.
- Teardown is fail-closed when a required session snapshot is not durable.
- Hosted deletion retains records after failure instead of pretending success.
- A global fleet sweep runs independently of new work and ignores the launch
  kill switch, which is the correct cleanup behavior.
- Ready capacity is account-owned rather than shared across tenants.
- The image is credential-free; launch secrets are injected only when claimed.
- Session state is separated from compute state and encrypted before control-plane
  storage.

## Findings

### P0 — a device-launched Hetzner server has no independent billing cutoff

`buildBootstrapUserData` schedules `shutdown -h now`. That terminates an EC2
instance because the adapter sets `InstanceInitiatedShutdownBehavior=terminate`,
and Fly uses process exit plus `auto_destroy`. A powered-off Hetzner server,
however, still exists and remains billable. Hosted Hetzner is deleted by
`/node/settled` or the global control-plane reconciler, but the device-driven
lane deliberately gives the control plane no provider token. If the device
disappears, “TTL self-shutdown” is **not** a bill-safety backstop for Hetzner.

Recommendation: do not describe device-launched Hetzner as self-destructing.
Before GA, choose one of:

- disable that lane unless a scoped delete capability is escrowed;
- mint/use a narrowly scoped, expiring teardown credential if Hetzner exposes
  one; or
- require hosted provisioning for Hetzner and make the trust trade-off explicit.

Power-off is still useful for containment, but it is not deletion.

### P0 — create is not transactional or recoverable

`launchEphemeralMachine` enrolls first, then calls `adapter.provision`, then adds
the returned machine to the store. Failure cases include:

- provider validation/create failure leaves an enrolled node and local room key;
- provider accepted create but the response was lost: the machine can exist with
  no known provider id;
- process crash after create but before `machines.add`: a hosted runner can be
  billable yet absent from reconciliation;
- a retry creates a new node/resource because there is no stable attempt id.

Recommendation: persist an attempt before any side effect:

```text
requested -> enrolling -> creating -> booting -> hydrating -> ready
                                      -> claimed -> working -> settling
                                      -> deleting -> deleted
                         any state -> failed/retrying/unknown
```

Each attempt needs `attemptId`, desired config, owner, provider operation key,
node id, provider id when known, deadlines, retry count, last error, and
`desiredState`. Tag every provider resource with `bivy-account`, `bivy-attempt`,
and `bivy-node` (opaque/HMAC account identity if raw ids are sensitive). Use
provider idempotency tokens where available (for example EC2 `ClientToken`). On
ambiguous failure, discover by attempt tag before creating again.

### P1 — tracked state is not a convergent controller model

The provider `status()` methods exist, but hosted reconciliation does not poll
provider state during provisioning/boot and primarily acts after settlement or
TTL. Lifecycle phases are inferred from milestones and purpose. There is no
startup deadline that converts “provider accepted but node never joined” into a
prompt delete/retry, and no explicit desired-vs-observed state.

Recommendation: run a reconciler over active attempts every 30–60 seconds:

- observe provider state and node/milestone state;
- enforce create, boot, hydration, work, settlement, and delete deadlines;
- retry idempotently with exponential backoff and jitter;
- move to `unknown` rather than `deleted` when observation is impossible;
- delete boot-failed resources promptly, retaining diagnostics separately;
- expose the last transition/reason in UI and audit evidence.

### P1 — whole-array storage and a fixed lease leave race windows

Hosted machines are read, modified, and written as one account JSON array.
Milestone writes, claims, settlement, reconciliation, and capacity maintenance
can overwrite one another. The five-minute lease can also expire while a slow or
wedged provider request still owns the operation, allowing another replica to
launch.

Recommendation: use one durable row per attempt with compare-and-swap/versioned
transitions. Renew leases while work is active, fence writes with a lease epoch,
and make claim + queue assignment one transaction. This also removes the current
crash window where capacity is marked claimed before pending work is routed.

### P1 — deletion needs discovery, not only a remembered provider id

Retaining a failed teardown record is correct, but it only helps if creation
reached `machines.add`. A robust finalizer must be able to list resources by
ownership/attempt tags and prove absence. Add adapter operations such as:

```ts
discover({ ownershipTag }): Promise<EphemeralMachine[]>
observe(machine): Promise<ObservedMachine>
ensureDeleted(machine): Promise<"deleted" | "pending" | "unknown">
```

Run periodic account/project orphan scans for hosted credentials. Keep provider
API calls bounded and audited.

### P1 — snapshot safety and cost expiry conflict silently

Self-teardown correctly refuses to exit if snapshot upload fails, but the
provider/guest TTL can still stop the machine later. That is the right cost
backstop, but users need to know the session may be lost when “snapshot blocked”
reaches the hard deadline.

Recommendation: track `snapshotBlockedAt`, surface a prominent warning, retry
aggressively, reserve a teardown budget before TTL, and emit a final durable
failure event. Consider stopping acceptance of new turns when too little TTL
remains to checkpoint safely.

### P2 — bootstrap and image rollout can be made more deterministic

The prebuilt image is the right direction. The generic fallback still executes
`curl | bash`, and configured images can be mutable tags. Cold start and supply
chain behavior are therefore less reproducible than the session model implies.

Recommendation: resolve images to immutable digests/AMI or snapshot ids, sign
and verify the runner image (for example cosign/Sigstore), publish an SBOM, and
record the exact image digest in the attempt. Keep the compatibility installer,
but pin its release/checksum rather than executing an unversioned installer.

### P2 — documentation and comments have drifted from behavior

Examples found during this review:

- `docs/ephemeral-sessions.md` says the UI is currently hidden, while both web
  and control-plane flags default on and only exact `0` disables them.
- The same document says a global hosted sweep is a follow-up, but
  `reconcileHostedMachineFleet` already runs every five minutes.
- `ephemeral-provisioner.ts` comments say production is off unless the flag is
  `1`, while `ephemeralMachinesEnabled` enables every value except `0`.
- The Fly adapter comment still says finish teardown is device-driven even
  though daemon self-teardown is now implemented.
- The inbound-thread section describes both landed wiring and the same wiring as
  missing.

Recommendation: generate lifecycle/provider capability tables from adapter
metadata where possible, and add a docs assertion test for feature-flag defaults
and provider teardown guarantees.

## Open-source landscape

These tools solve adjacent problems; none matches Bivy end to end.

| Tool | What it provides | What Bivy should learn/reuse | Fit |
|---|---|---|---|
| [GitHub Actions Runner Controller](https://github.com/actions/actions-runner-controller) (Apache-2.0) | Kubernetes operator and autoscaling runner scale sets; ephemeral job runners | Reconciliation/finalizers, scale-from-demand, explicit warm capacity, one workload per disposable runner | Patterns only unless Bivy requires Kubernetes |
| [GitLab Runner instance executor](https://docs.gitlab.com/runner/executors/instance/) with [fleeting](https://docs.gitlab.com/runner/runner_autoscale/) and taskscaler | Provider plugins over instance groups, idle capacity, max-use count, immediate delete after a job | Separate provider inventory from task capacity; acquire/release semantics; preemptive ready capacity; instance use-count | Strongest lifecycle reference, but coupled to GitLab Runner/instance groups and written in Go |
| [DevPod](https://github.com/loft-sh/devpod) (MPL-2.0) | Client-only devcontainer workspaces across local, SSH, Kubernetes, and cloud provider plugins | Portable provider UX and the devcontainer boundary; provider plugins as external executables | Not a controller replacement; possible optional workspace backend |
| [Coder envbuilder](https://github.com/coder/envbuilder) (Apache-2.0) | An OCI image that clones a repo, builds `devcontainer.json`/Dockerfile, then runs an init script | Plug-and-play repository environment hydration and cache/prebuild strategy | **Usable component** when Docker/devcontainers are supported; not machine lifecycle |
| [SWE-ReX](https://github.com/SWE-agent/SWE-ReX) (MIT) | A Python runtime interface for commands/files across sandbox backends | Keep agent execution separate from machine provisioning; backend contract tests | Useful reference or optional sidecar, but duplicates Bivy's runtime/relay boundary |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | Agent platform with Docker/Kubernetes runtime options and persisted conversations | Conversation/compute separation and runtime isolation choices | Product/reference, not a provisioning component |
| [Daytona](https://github.com/daytonaio/daytona) | API/SDK sandbox lifecycle, fast starts, snapshots, control-plane/compute-plane split | Managed provider adapter; native snapshots could replace Bivy rebuild on that substrate | Technically attractive, but current licensing/self-host story must be verified; do not vendor blindly |
| [OpenTofu](https://github.com/opentofu/opentofu) (MPL-2.0) / Crossplane | Mature provider ecosystems and declarative convergence | Desired/observed state and provider adoption/import | Too heavy for one-machine browser launches; possible enterprise hosted backend only |
| [Karpenter](https://github.com/kubernetes-sigs/karpenter) (Apache-2.0) | Demand-driven cloud node provisioning and consolidation | Disruption budgets, expiry, drift detection, interruption handling | Excellent patterns; only useful directly if Kubernetes is already mandatory |

### Why not replace adapters with Terraform/OpenTofu?

It would add state files, locking, provider binaries, plugin supply-chain
management, and a control-plane execution service. It cannot run in the current
browser-held-token path and still would not solve Bivy enrollment, E2E pairing,
session snapshots, or quiet teardown. For long-lived enterprise infrastructure
it may be a valid optional backend; it is not the default ephemeral path.

### What is genuinely plug-and-play?

- **Now:** no full lifecycle controller.
- **Low-risk experiment:** run envbuilder inside a dedicated runner image to
  hydrate repositories that contain `devcontainer.json`; keep Bivy as PID 1 /
  supervisor and preserve its relay/teardown contract.
- **Provider experiment:** add Daytona only through `ProviderAdapter`, behind
  `experimental`, after testing create/timeout/snapshot/delete against a real
  account and resolving license/hosting expectations.
- **Deployment-specific:** offer ARC/Karpenter-backed runners only as an operator
  mode for customers who already have Kubernetes. Do not make Kubernetes a Bivy
  prerequisite.

## Recommended implementation sequence

### Phase 1 — cost and orphan safety

1. Correct the device-Hetzner guarantee or disable the unsafe lane.
2. Introduce durable per-attempt rows and write `requested` before enrollment.
3. Add stable attempt ids, provider ownership tags, and EC2 `ClientToken`.
4. Roll back enrollment on definite create failure.
5. Add provider discovery and an orphan sweeper for hosted accounts.

### Phase 2 — reconciler

1. Replace inferred-only lifecycle with desired/observed transitions.
2. Poll active provider status and enforce boot/hydration/delete deadlines.
3. Add renewable fenced leases and row-versioned transitions.
4. Atomically claim ready capacity and assign work.
5. Add backoff, terminal reasons, and operator retry/force-delete controls.

### Phase 3 — reproducibility and optional integrations

1. Pin and attest images/installers; record exact artifact identities.
2. Live-test the complete create → first event → snapshot → destroy → rebuild
   cycle per provider, including injected lost-response and CP-restart failures.
3. Prototype envbuilder for devcontainer hydration.
4. Evaluate Daytona and a Kubernetes operator mode as optional providers, not
   architectural replacements.

## Acceptance tests the lifecycle is currently missing

- Crash after node enrollment but before provider create.
- Provider creates a resource but the HTTP response is lost.
- Crash after provider create but before machine tracking.
- Provision lease expires while create is still in progress.
- Two reconcilers/settled requests race on the same machine.
- Ready runner claim crashes before work assignment.
- Node never joins after provider acceptance.
- Provider credential is revoked before teardown, then restored.
- Device vanishes during a Hetzner run.
- Snapshot upload fails until shortly before hard TTL.
- Control plane restarts during create and during delete.
- Provider reports 404, transient 5xx, throttling, and an unknown state.
- Orphan scan finds a tagged provider resource absent from Bivy inventory.

The target invariant should be:

> Every create has a durable attempt before the provider call; every resource is
> discoverable by that attempt; every attempt converges to ready or confirmed
> deleted; and uncertainty is retained and retried rather than reported as
> success.
