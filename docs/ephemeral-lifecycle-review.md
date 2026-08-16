# Ephemeral servers and provider review

> Current implementation review. This evaluates the product flow, lifecycle
> controller, existing providers, and the next providers that best fit coding and
> general-purpose agents. Provider prices and external API details still require
> live verification before release.

## Executive summary

Bivy's hosted lifecycle is now substantially stronger than a conventional
"create a VM and remember its id" integration. It writes a durable attempt before
provider side effects, uses stable operation identities, tags resources, adopts
ambiguous creates, observes active machines, enforces boot/TTL deadlines, fences
attempt updates, confirms deletion, and discovers tagged orphans. Keep this
controller and the small `ProviderAdapter` boundary.

Bivy now models CPU, memory, disk, architecture, price provenance, and
accelerators as structured facts and maps plans to agent-oriented workload
intents. New profiles default to an 8 GB-class baseline. AWS exposes curated T3,
M7i, and R7i plans up to 128 GB with a disposable 40 GB gp3 root disk; Hetzner's
live catalog remains the value-oriented large-memory path. GPU execution still
requires a pinned driver-ready image and live certification before it should be
advertised.

Recommended order:

1. Make compute profiles and provider preflight agent-aware: structured CPU,
   memory, disk, architecture and accelerator facts; `Standard`, `Large`,
   `Memory optimized`, and `GPU` intents; realistic defaults; launch readiness
   checks and capacity fallback.
2. Expand **AWS EC2** first. The auth and lifecycle integration already exist,
   and EC2 can provide large-memory and GPU machines. Add M/R families, disk and
   network configuration, then GPU families with a pinned driver-ready image.
3. Add **RunPod** as the first GPU-specialist provider after the capability model
   exists. Treat it as hosted-controller-only until server-side expiry/deletion
   behavior is proven in live tests.
4. Add one low-friction, token-based CPU provider only if it improves availability
   or geography. DigitalOcean is the simplest candidate; because guest shutdown
   does not delete a Droplet, use the same hosted-only safety posture as Hetzner.
5. Do not add GCP, Azure, Vast.ai, Lambda Cloud, Modal, or another sandbox API just
   to increase the logo count. Their setup, variability, or execution model is a
   worse default for this product today.

Fly Sprites and E2B support was removed. Their unverified suspend/resume
lifecycles added a second controller policy, extra credential/SSRF surface, and
product claims that had not passed live billing certification. Portable encrypted
snapshots remain the single continuity model across supported providers.

## What is implemented well

### General provider boundary

Provider-specific behavior is isolated in:

- `packages/core/src/ephemeral-providers/*`
- `packages/core/src/ephemeral-provider-ports.ts`
- `packages/core/src/ephemeral-provider-registry.ts`
- `packages/core/src/ephemeral-catalog.ts`

The same adapters can run through the browser/node request broker or directly in
the hosted control plane. Statuses are normalized and adapters own signing,
request shapes, idempotency/adoption, and deletion. This is the right level of
abstraction. Do not replace it with Terraform/OpenTofu or a provider SDK per UI
surface.

### Hosted lifecycle controller

The earlier transaction/orphan risks have been addressed:

- A `hosted_machine_attempts` row is written at `requested`, before enrollment.
- AWS uses `ClientToken`; Fly and Hetzner adopt by stable attempt metadata.
- Resources carry attempt and opaque account ownership tags.
- Provider acceptance is persisted before legacy machine inventory.
- Reconciliation adopts attempt-owned machines missing from inventory.
- Pre-acceptance failures retry with the same attempt and node identity.
- Active attempts are observed and boot failures are deleted on a deadline.
- Desired deletion is durable and deletion is confirmed by a later observation.
- Versioned/fenced attempt writes prevent two reconcilers from owning teardown.
- Provider discovery finds tagged Fly, Hetzner and EC2 resources absent from both
  attempt and inventory state.
- The provision lease has a heartbeat rather than a fixed unrenewed ownership
  window.

This is now a convergent controller for the hosted lane. The remaining storage
weakness is the legacy whole-array machine inventory, but attempts are the durable
source for lifecycle recovery. Continue migrating read models away from the array
instead of redesigning provider adapters.

### Cost safety

- Fly process exit plus `auto_destroy` and EC2 guest shutdown plus
  `InstanceInitiatedShutdownBehavior=terminate` are provider-native backstops.
- Device-only Hetzner launch is refused because power-off remains billable.
- Hosted teardown keeps records after errors and retries independently of the
  new-launch kill switch.
- Snapshot failure blocks normal self-teardown while provider TTL remains the
  final cost ceiling.

These guarantees should become generated provider capability facts and contract
tests, not duplicated prose.

## Current provider assessment

| Provider | Current fit | Agent capacity today | Main gaps | Recommendation |
|---|---|---|---|---|
| Fly Machines | Best simple interactive default; low setup and native auto-delete | Recommended 4 shared vCPU / 8 GB | No live size/region capacity, no disk control, app cleanup, generic image cold start | Keep stable; add larger/performance profiles only after live capacity and price checks |
| Hetzner Cloud | Excellent CPU/RAM value; live size and location availability | Live catalog exposes dedicated and high-memory plans | Explicit deletion required; ARM compatibility not enforced | Keep stable and hosted-only; use one hosted-custody profile wizard |
| AWS EC2 | Broadest path to memory, CPU, GPU, networking and compliance | Curated T3/M7i/R7i up to 16 vCPU / 128 GB, 40 GB gp3 root | Default-VPC assumption, no subnet/security group selection, no certified GPU image/driver lane, cumbersome credential input | Highest-priority expansion |

### Current defaults are undersized

A coding agent is not just an editor process. It commonly runs package installs,
TypeScript compilation, tests, browsers, language servers, Docker builds, and
multiple tool subprocesses. A 1–2 GB machine is an avoidable source of OOMs and
poor first impressions.

Use these product intents as a starting point, then validate with repository
benchmarks:

| Intent | Minimum target | Typical use |
|---|---|---|
| Quick | 2 vCPU, 4 GB RAM, 20+ GB disk | Small fixes and review |
| Standard (recommended) | 4 vCPU, 8 GB RAM, 40+ GB disk | Normal coding agent session |
| Large | 8 vCPU, 32 GB RAM, 80+ GB disk | Monorepos, browser tests, Docker builds |
| Memory optimized | 16 vCPU, 64–128 GB RAM, 100+ GB disk | Large builds, indexing, data work |
| GPU | 8+ vCPU, 32–64 GB RAM, 100+ GB disk, NVIDIA accelerator with declared VRAM | CUDA tests, model/data workloads |

Do not silently map an intent to a smaller machine. If unavailable, offer a clear
fallback with the changed specification and price before launch.

## Product-flow findings

### 1. Provider-native labels are doing the job of a compute model

`ProviderSize` has only `id`, `label`, and optional price. CPU, RAM, disk,
architecture and GPU details are embedded in human strings. Bivy therefore
cannot:

- recommend a size based on workload;
- compare providers;
- warn that a repository exceeds available disk/RAM;
- filter ARM-incompatible agents or images;
- select a compatible GPU image;
- report capacity separately from price;
- provide an equivalent fallback in another region.

Add structured optional facts while preserving the provider-native id:

```ts
interface ProviderSize {
  id: string;
  label: string;
  vcpus?: number;
  memoryMiB?: number;
  diskGiB?: number;
  architecture?: "x86_64" | "arm64";
  accelerator?: { vendor: "nvidia" | "amd"; model: string; count: number; memoryMiB?: number };
  pricePerHour?: number;
  priceSource?: "live" | "indicative";
}
```

Disk may belong to profile configuration rather than a fixed size on providers
such as EC2. Keep it structured either way.

### 2. Authentication is stored generically but presented too generically

A single opaque secret is a useful storage boundary, but it should not force one
password input in the UI. AWS asks users to construct
`accessKeyId:secretAccessKey[:sessionToken]`, while other providers need a bearer
token. Introduce a catalog-driven credential form schema and serialize it into
the existing secret field internally. This keeps the adapter/store general while
allowing separate labels, validation, temporary-credential guidance, and future
project/org fields.

Prefer short-lived credentials. For AWS, document and support temporary STS
credentials as the recommended path; long-lived IAM user keys should be a
fallback, not the first instruction.

### 3. Read-only token validation is not launch readiness

Current validation proves authentication, not that a useful agent machine can be
created. AWS validation can pass when there is no default VPC, no public route,
no SSM permission, no quota for the chosen family, or no capacity. Similar gaps
exist for provider organization/project selection and managed templates.

Add an adapter `preflight(profile)` result with structured checks:

- authentication and required scopes;
- region and selected size offered/orderable;
- network path for outbound relay/Git/provider access;
- image/template exists and matches architecture/GPU;
- disk and account quota;
- independent teardown authority;
- estimated price provenance.

Run cheap checks when saving a profile and again immediately before launch. A
preflight must not create billable compute.

### 4. Hosted-only onboarding uses the correct custody

Hetzner setup now validates and stores its credential in encrypted hosted custody
and creates the reusable compute profile in the same wizard. The interactive
sheet explains why a device-held token cannot provide independent deletion
authority instead of accepting an unusable local credential.

### 5. Launch readiness should be measured at the agent boundary

Provider `running` is not success. Keep using first-agent-event cold start as the
user metric, and add explicit bootstrap/runtime health milestones:

- provider accepted;
- guest reachable/outbound network working;
- Bivy daemon joined;
- repository ready;
- model/Git credentials ready;
- selected agent installed and passed a no-op health check;
- first turn started.

Show actionable failure reasons and a retry/fallback action. Preserve provider
logs or a bounded bootstrap diagnostic artifact for failed boots without keeping
a billable machine alive by default.

### 6. Capacity failures need bounded fallback

Large and GPU instances are frequently unavailable in a particular region. Add a
declarative fallback policy to profiles: exact only, same class in selected
regions, or ask before substitution. Each attempt should record every candidate
and failure. Never substitute a more expensive size without an explicit maximum
hourly price or confirmation.

## New-provider priorities

### P0: expand AWS before adding another general cloud

This gives Bivy large memory and GPU without another credential or lifecycle
surface.

1. Add subnet and security-group selection/discovery; stop assuming a default VPC.
2. Add configurable gp3 root volume size with a safe agent default.
3. Resolve live instance offerings for the selected availability scope, not only
   instance type definitions.
4. Add curated current-generation general-purpose and memory-optimized families.
5. Add GPU profiles only with pinned, architecture-compatible images that include
   a verified NVIDIA driver/toolkit, or a deterministic driver bootstrap that is
   tested against every image.
6. Include volume cost and region-specific compute pricing when available; label
   fallback prices as indicative.
7. Extend the minimal IAM policy and validation tests for the new describe,
   networking and volume operations.

Do not expose a raw list of hundreds of EC2 types. Show workload intents and an
advanced native-type picker.

### P1: RunPod for GPU

RunPod is the best next specialist to evaluate because GPU inventory is its core
product and API-key onboarding can be much simpler than configuring another
hyperscaler. It is container/template-oriented, so use a credential-free pinned
Bivy runner image rather than adapting cloud-init.

Proof required before integration is marked preview:

- live create, status, logs, terminate and ambiguous-response adoption;
- ownership/attempt tagging and account-wide discovery;
- deterministic maximum runtime or control-plane deletion authority;
- dynamic GPU inventory including model, count, VRAM, region/community tier and
  price;
- persistent/network volume behavior and deletion cost;
- outbound relay/Git/model connectivity;
- no provider token or model credential in image metadata;
- behavior when requested GPU stock disappears between preflight and create.

Start hosted-only. A device-only lane is acceptable only if the provider itself
can guarantee deletion at the hard deadline without trusting the browser or
control plane.

### P2: one simple CPU cloud, probably DigitalOcean

DigitalOcean's token-oriented API and Droplet model are a straightforward
availability/geography complement. It does not add a unique compute class, so it
comes after AWS expansion and GPU support. Because shutting down a Droplet does
not prove resource deletion, mark it hosted-only unless a provider-native expiry
mechanism is demonstrated.

Vultr is an alternative if its live GPU and high-memory inventory proves more
useful, but it should compete for this slot rather than being added alongside
DigitalOcean immediately.

### Defer

- **GCP/Azure:** excellent compute, poor minimum-setup fit until Bivy has a guided
  workload-identity/OAuth flow; service-account JSON pasted into a browser is not
  a good default.
- **Vast.ai:** broad cheap GPU supply, but marketplace host variability,
  availability and security posture need a separate trust tier and stronger
  image/runtime attestation.
- **Lambda Cloud:** useful GPU inventory but quota/availability and SSH-oriented
  setup make it a less general first GPU integration than RunPod or existing AWS.
- **Modal:** a function/application runtime, not a natural host for Bivy's
  long-lived interactive daemon and portable session lifecycle.
- **Managed sandboxes:** Sprites and E2B were removed. Do not add Daytona or a
  similar substrate without a compelling advantage over the portable VM lane
  and the complete create/snapshot/delete certification suite.
- **Kubernetes:** support later as an operator/deployment mode for customers who
  already own clusters, not as a first-run provider.

## Implementation plan

### Phase 1 — honest, agent-fit UX (completed)

1. Structured compute capabilities and profile intents.
2. An 8 GB-class recommended agent baseline.
3. Removal of unverified Sprites/E2B provider and suspend lifecycle support.
4. Hosted-only setup routed directly to hosted credential custody.
5. Correct teardown copy: daemon/control-plane teardown does not require the
   launching device.
6. Remaining refinement: generate provider capability/teardown tables from
   catalog and adapter facts.

### Phase 2 — AWS large-memory lane

1. Network and root-disk configuration.
2. Live offering checks and current-generation M/R profile mappings.
3. Region-specific price retrieval/cache or clearly marked indicative prices.
4. End-to-end tests on `Standard`, `Large`, and `Memory optimized` profiles.

### Phase 3 — GPU lane

1. Add accelerator/image compatibility to profile validation.
2. Build, sign and publish a GPU runner image with SBOM and exact digest.
3. Certify one AWS GPU profile.
4. Implement RunPod behind `preview`, hosted-only.
5. Add GPU stock fallback with price caps and explicit substitutions.

### Phase 4 — reliability and certification

Create a provider certification matrix that is generated from live tests, not a
hand-maintained stable badge. A provider/compute class is available only when the
following pass in a dedicated account:

- invalid and under-scoped credential errors;
- preflight with missing network/image/quota prerequisites;
- create through first agent event;
- large dependency install and representative repo test;
- timeout/lost create response and idempotent adoption;
- control-plane restart during create and delete;
- boot failure and deadline teardown;
- finish, snapshot, confirmed delete, and rebuild-resume;
- revoked teardown credential followed by repair;
- discovery of a deliberately untracked tagged resource;
- provider 404, 429 and transient 5xx handling;
- advertised CPU/RAM/disk/accelerator observed inside the guest;
- bill/inventory empty after cleanup.

Publish last-certified timestamp, regions/classes tested, image digest, and known
limitations in the UI. `stable` should mean this suite passed recently, not only
that adapter unit tests exist.

## Target product invariant

> A user chooses a workload intent, not cloud trivia. Bivy selects a compatible,
> available machine within an explicit price limit; proves the agent is ready;
> preserves useful session state; and converges every accepted resource to
> provider-confirmed deleted without relying on the user's device.
