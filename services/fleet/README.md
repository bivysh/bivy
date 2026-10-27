# Bivy fleet

Runs the machines Bivy hands out: one sleeping **cloud computer** per account,
and optional disposable **runners** beside it for work that should go in
parallel. It is the third service in the stack, next to the control plane and
the relay, and it is entirely optional — without it, Bivy runs sessions only on
machines people connect themselves.

```
  phone / browser ──▶ control plane ──▶ fleet ──▶ machine provider (Fly)
                           ▲                            │
                           └──── node dials the relay ◀──┘
```

## What it owns, and what it does not

| The fleet decides | Core decides |
| --- | --- |
| Which machine, where, how big | The node's identity and its boot payload |
| When to start, stop and delete one | What runs in a session |
| The disk and how it grows | Who the account is, and how to reach them |
| How much awake time was used | Whether a client may connect at all |

The fleet never sees session content and holds no room key: a machine generates
its own key on its own disk, exactly like a laptop someone connects. It holds
one secret — the provider credential — and never hands it to anything else.

## Run it

Three things are required:

```sh
FLEET_PROVIDER_TOKEN_FLY=…      # a provider credential scoped to one org
FLEET_IMAGE=registry/bivy-runner:…   # an image with Bivy already installed
FLEET_CORE_URL=http://control-plane:4400
DEPLOYMENT_COMPUTE_TOKEN=…      # the same secret the control plane has
```

`DATABASE_URL` is optional but wanted: without it the fleet keeps its records in
memory and forgets which machines it owns on restart. It can share the control
plane's database — its tables are all `fleet_*`.

Then point the control plane at it:

```sh
DEPLOYMENT_COMPUTE_URL=http://fleet:4600
DEPLOYMENT_COMPUTE_TOKEN=…
EPHEMERAL_MACHINES_ENABLED=1
```

`deploy/docker-compose.yml` wires all of this for a single-server install; see
[docs/ephemeral-sessions.md](../../docs/ephemeral-sessions.md) for the full
setup, including building the machine image.

## Configuration

Everything is read in [`src/settings.ts`](src/settings.ts) and nowhere else.
The `MANAGED_*` names a deployment used before this service lived in Core are
still accepted.

| Name | Default | What it does |
| --- | --- | --- |
| `FLEET_PROVIDER` | `fly` | Which adapter in `src/provider.ts` |
| `FLEET_PROVIDER_TOKEN_FLY` | — | The provider credential |
| `FLEET_PROVIDER_ORG` | discovered | The provider organization to create apps in |
| `FLEET_IMAGE` | — | Machine image with Bivy installed |
| `FLEET_IMAGE_CLAUDE` / `_CODEX` / `_PI` | `FLEET_IMAGE` | Smaller per-agent images, when prebuilt |
| `FLEET_LABEL` | `Cloud computer` | What the app calls this destination |
| `FLEET_REGION` | `iad` | Where machines run |
| `FLEET_SIZE` | `shared-4x-8gb` | Default size (see `src/sizes.ts`) |
| `FLEET_DISK_GB` | `20` | A new disk's size, included for every account |
| `FLEET_DISK_MAX_GB` | `100` | The largest disk an account may grow to |
| `FLEET_AWAKE_CAP_MINUTES` | `360` | Longest single awake stretch |
| `FLEET_IDLE_DELETE_DAYS` | `30` | Delete an untouched machine and disk after this |
| `FLEET_IDLE_WARN_DAYS` | `7` | Tell the account this far ahead |
| `FLEET_CPU_GUARD_PERCENT` | `90` | Stop a machine pinning its CPUs this hard (`0` off) |
| `FLEET_CPU_GUARD_MINUTES` | `60` | …for this long |
| `FLEET_RUNNERS` | off | `1` also runs per-work runners |
| `FLEET_MAX_RUNNERS_PER_ACCOUNT` | `3` | Runners one account may have awake |
| `FLEET_MAX_MACHINES` | `0` (no cap) | Machines the whole fleet may run at once |
| `FLEET_MONTHLY_HOURS` | `0` (unmetered) | Machine hours an account gets per month |
| `FLEET_SIZE_CLASSES` | all | Size classes accounts may pick |
| `FLEET_NAME` | — | Names this fleet's apps, so two fleets can share one provider org |
| `FLEET_SWEEP_ORPHANS` | on | `0` stops deleting apps no record owns — set it while adopting machines whose records are not here yet |
| `FLEET_EARLY_STARTS` | off | Start at sign-up and on presence; meter from first use |
| `FLEET_GUEST_HARDENING_ATTESTED` | — | Required in production: you have checked the image's egress and process controls |
| `FLEET_POLICY_URL` / `_TOKEN` | — | An operator policy service, applied on top of these caps |

Hours are **Standard hours**: an awake hour on a bigger size uses more of them,
by the `weight` column in `src/sizes.ts`.

## Limits, and selling machine time

The caps above are the fleet's own, applied by `src/limits.ts` with no further
service. They are what makes running a fleet for other people safe: no account
can spend an operator's provider budget without end.

An operator who *sells* machine time points `FLEET_POLICY_URL` at a service of
their own. It answers `/v1/policy/check` (may this account start a machine?)
and, optionally, `/v1/policy/compute/limits`, `/v1/policy/compute/runs` and
`/v1/policy/compute/disk`. Both sets of answers apply: a policy service can
lower a ceiling per account, never raise the deployment's own. Plans, prices
and tiers stay in that service — they never enter this repo.

The fleet always meters awake time itself. `/v1/compute/usage` reports it per
account, which is what an invoice is built from.

## Tests

```sh
npm ci && npm run test:unit
```

The suites drive the real `CloudComputers` and `Runners` against a fake
provider and an in-memory store, so machine lifecycle, metering, the CPU guard,
idle deletion and runner sleep are covered without touching a provider.
