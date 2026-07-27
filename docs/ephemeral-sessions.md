# Ephemeral sessions

> **Status: not currently enabled.** The ephemeral-machines UI is hidden behind a
> feature flag (`EPHEMERAL_MACHINES_ENABLED` in `packages/web/src/flags.ts`) while
> the feature is built out. This page documents the design and the code that
> remains in the tree; it is not linked from the docs index or the site yet.

Ephemeral sessions are short-lived Bivy nodes created for one task/session. The control plane still stores metadata only; prompts, files, tool output, credentials, and agent transcripts remain on the ephemeral machine and are destroyed with it unless the user explicitly exports a branch/PR/artifact.

## Product shape

1. **Bivy-hosted pool**
   - Bivy provisions the machine (Fly Machines, later other providers).
   - User supplies agent/model credentials through the existing vault/provider flow.
   - Best default for first-run and non-infra users.

2. **User cloud account**
   - User connects Fly.io, Hetzner, etc. keys to the control plane vault.
   - Bivy provisions machines in the user's account/project.
   - Good for cost/control/compliance while keeping one Bivy UX.

3. **Bring-your-own VM/server**
   - User provides Hetzner SSH/API keys or an existing SSH target.
   - Bivy bootstraps the node with the installer, pairs it to the account, runs the session, then tears it down if Bivy created it.

## Core rule

The user brings secrets; Bivy brings orchestration.

Credential sources can be manual entry, Bivy vault, 1Password/Secrets Automation, provider CLIs already logged in on the node, or environment injection. Secrets should be scoped to the ephemeral node/session where possible and revoked or deleted on teardown.

## UI flow: provider key quick guides

Implemented now: the remote UI's node selector has an **⚡ Ephemeral machine** entry. Users can save multiple named setups per provider, each with its own region, size, TTL, repository, and optional **destroy when the agent finishes** policy. Finish-triggered teardown runs from the launching web device after `agent_end` (including turns that create a PR); the TTL always remains a safety fallback if that device goes offline. These setups appear in the node selector like offline persistent nodes; selecting one opens a pre-filled launch view, and the setup remains after each short-lived machine expires. The provider token is shared by that provider's setups and stored **on the device** — in the PWA's IndexedDB (`bivy-ephemeral` DB, `provider-keys` store). Saved setups use the device-local `setups` store. Neither tokens nor setups touch the control plane, so a user can configure them from a phone before owning a computer/server.

The token field is a single opaque string as far as the store/UI are concerned — Fly and Hetzner treat it as a bearer token, while AWS's adapter parses it as `accessKeyId:secretAccessKey[:sessionToken]`. Nothing outside the adapter needs to know which shape a given provider uses.

When the user selects an ephemeral provider, show a short inline guide before asking for the key. Prefer direct links that open in a new tab.

## Provisioning path (implemented)

Because the token lives on the device, **all provider orchestration runs in the browser** (`packages/core/src/ephemeral.ts`, the `ProviderAdapter` implementations): each adapter builds the create/status/destroy requests, mint the bootstrap user-data, and drives the lifecycle. AWS additionally signs each request (SigV4) client-side before it's sent — see "Adding a new provider" below. The browser can't call the provider APIs directly (no CORS), so it asks a **transport** to run one allowlisted HTTPS request on its behalf:

- **node-broker (default, end-to-end):** when the account has a node online, the browser sends an `ephemeral.exec` frame over the E2E relay; the node runs the request (`src/ephemeral-exec.ts`) and returns the result. The control plane never sees the token.
- **cloud relay (cold start):** with no node online, the browser posts the request to the control plane's `POST /api/ephemeral/exec` (`requireUser`), which forwards it once and **never stores or logs it**. This lets a phone launch its first machine, at a softer guarantee (the token is TLS-terminated in-flight at the control plane).

Both proxies enforce the same host allowlist as the SSRF guard: `api.hetzner.cloud`, `api.machines.dev`, `api.fly.io`, plus per-region `ec2.<region>.amazonaws.com`/`ssm.<region>.amazonaws.com` hosts for AWS. It's kept in lock-step across three copies — `ALLOWED_HOSTS` in `packages/core/src/ephemeral.ts`, `EPHEMERAL_ALLOWED_HOSTS` in `src/ephemeral-exec.ts`, and the control plane's own copy in `services/control-plane/src/index.ts` — since the control plane is deliberately kept dependency-light and doesn't import `@bivy/core`.

Launch flow (browser):

1. Enroll a fresh `nodeId` with the control plane (`POST /nodes/enroll`, account session) → enrollment token.
2. Mint a 32-byte room key; keep it on the device (for reach) and bake it into the machine's `relay.json`. On the node-broker path the relay/control plane never see it.
3. Build cloud-init user-data that installs Bivy, writes `/etc/bivy/relay.json`, and arms a **self-shutdown at TTL** so a forgotten machine can't bill forever.
4. `provision()` via the chosen transport; store the machine record on the device (`bivy-ephemeral` → `machines`) so it can be listed/destroyed later.
5. The node boots, pairs over the relay, and appears in the node list; the browser already holds its room key, so sessions are reachable.

Teardown: a **Destroy now** button runs `destroy()` via the same transport and deregisters the node. TTL self-shutdown is the backstop when the device is gone. Machine records are device-local only — the control plane holds none.

Caveat: the adapters are written against each provider's documented API shape and are unit-tested via an injected transport (`packages/core/test/ephemeral-aws.test.ts`, `packages/core/test/ephemeral-stores.test.ts`) plus the node SSRF proxy (`test/ephemeral-exec.test.ts`), but live end-to-end provisioning still needs a real token/account per provider to confirm.

## Adding a new provider

The whole point of `ProviderAdapter` is that adding a provider is additive — no shared dispatch/call site (the UI, the controller, `launchEphemeralMachine`/`destroyEphemeralMachine`/`listEphemeralSizes`) needs to change. It only needs to know a provider's `id` string. Checklist, using the AWS adapter as the reference example:

1. **Catalog entry** — add an `EphemeralProviderCatalog` object to `EPHEMERAL_PROVIDERS` in `packages/core/src/ephemeral.ts`: `id`, `name`, `tokenLabel` (what the UI's single text field is asking for — one bearer token, or a composite like AWS's `accessKeyId:secretAccessKey`), `blurb`, `steps` (numbered setup copy), and `links` (opens in a new tab). This alone makes the provider selectable and show its guide — the UI (`packages/web/src/components/Ephemeral.tsx`) renders straight from the catalog.
2. **`ProviderAdapter`** — implement `provision`/`status`/`destroy` (and `listSizes` if the provider has a live catalog worth preferring over a static list) against the `ExecFn` your adapter is handed. Everything provider-specific — auth, status-string mapping, request/response shape — stays inside the adapter:
   - **Auth.** If the provider uses a single bearer token, mirror Fly/Hetzner directly. If it needs more than one secret (like AWS's access key + secret key), keep the token store's `token` field a single opaque string and parse a composite format inside the adapter (see `parseAwsToken`) — don't change `EphemeralKeyStore`'s shape or the UI for this.
   - **Signing.** If the provider needs request signing rather than a static header (SigV4, HMAC, etc.), do it inside the adapter before calling `exec` — the exec proxy (node broker or cloud relay) is a dumb forwarder that sends whatever `{method, url, headers, body}` it's given; it never needs to know how a request was authenticated. See `awsSign` for a Web-Crypto-only (no dependency) SigV4 implementation.
   - **Response shape.** If the provider doesn't speak JSON (EC2's Query API returns XML), parse it inside the adapter — see `parseXml`/`xmlChild`/`xmlChildren`/`xmlFind`, a small dependency-free reader. Downstream code only ever sees the adapter's normalized `EphemeralMachine`/`ProviderSize`/status-string return values.
   - **Status mapping.** Normalize the provider's native status strings to Bivy's `"starting" | "running" | "stopped" | "gone"` inside the adapter (see `mapHetznerStatus`/`mapFlyStatus`/`mapAwsStatus`) — nothing outside the adapter should see a provider-native status string.
3. **Register the adapter** in the `ADAPTERS` map at the bottom of `packages/core/src/ephemeral.ts`.
4. **Allowlist the API host(s)** in all three places that must stay in lock-step (a deliberate, documented duplication — see "Provisioning path" above for why there are three): `ALLOWED_HOSTS` in `packages/core/src/ephemeral.ts`, `EPHEMERAL_ALLOWED_HOSTS` in `src/ephemeral-exec.ts`, and the control plane's own copy in `services/control-plane/src/index.ts`. This is the SSRF guard — a request to any other host is refused before it's sent.
5. **Tests.** Unit-test the adapter's `provision`/`status`/`destroy`/`listSizes` against a fake `ExecFn` that returns canned provider responses (see `packages/core/test/ephemeral-aws.test.ts`), and add the new host(s) to the allowlist assertions in `test/ephemeral-exec.test.ts`. If the provider needs custom request signing, add a few golden test vectors from the provider's own published documentation/test suite rather than trusting a from-memory implementation.
6. **Docs** — add a provider section here (setup copy, links, any IAM/permission-scoping notes) mirroring Fly.io/Hetzner/AWS above.

### Fly.io

Copy for the UI:

1. Create or sign in to a Fly.io account: <https://fly.io/user/personal_access_tokens>
2. Click **Create token**.
3. Use a short-lived/deploy token if Fly offers one for your account; otherwise create a personal access token you can revoke after the session.
4. Paste the token into Bivy.
5. Bivy will create a temporary machine, install the selected agent, run the session, push/export results, then destroy the machine.

Helpful links:
- Tokens: <https://fly.io/user/personal_access_tokens>
- Organizations/apps dashboard: <https://fly.io/dashboard>
- Machines docs: <https://fly.io/docs/machines/>

### Hetzner Cloud

Copy for the UI:

1. Open Hetzner Cloud Console: <https://console.hetzner.cloud/projects>
2. Select or create a project for Bivy's temporary runners.
3. Go to **Security → API Tokens**.
4. Click **Generate API token**.
5. Choose **Read & Write** so Bivy can create and destroy a server.
6. Paste the token into Bivy.
7. Bivy will create a temporary server, bootstrap Bivy, run the selected agent, push/export results, then delete the server.

Helpful links:
- Projects: <https://console.hetzner.cloud/projects>
- API token docs: <https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/>
- Cloud API docs: <https://docs.hetzner.cloud/>

### AWS EC2

Copy for the UI:

1. In the IAM console, create (or reuse) a user scoped to a minimal EC2 policy — see the policy below.
2. On that user, open **Security credentials → Access keys → Create access key**.
3. Paste both values into Bivy as `accessKeyId:secretAccessKey` (append `:sessionToken` if you're using temporary STS credentials instead of a long-lived IAM user).
4. Bivy will launch a temporary EC2 instance, install the selected agent, run the session, push/export results, then terminate the instance.

Helpful links:
- IAM access keys: <https://console.aws.amazon.com/iam/home#/security_credentials>
- EC2 console: <https://console.aws.amazon.com/ec2/home>

**Why EC2, not Fargate/ECS.** EC2's `RunInstances` + `UserData` maps directly onto the "create a VM, run cloud-init, destroy it" model this doc already describes for Fly/Hetzner — one call launches an instance with the same `#cloud-config` payload used everywhere else. Fargate/ECS has no equivalent to cloud-init/user-data (it launches containers from a pre-built image against a task definition, and needs a cluster + task definition to exist first); adapting to it would mean a different bootstrap mechanism (an image build/push step) rather than reusing the existing one. EC2 also starts running user-data within ~15s of the API call, comparable to or faster than an unoptimized Fargate cold start (20–60s, dominated by ENI provisioning + image pull).

**AMI.** Rather than hardcode an AMI id (which eventually goes stale as Canonical publishes new builds), the adapter resolves the current Ubuntu 24.04 (Noble) amd64 AMI at provision time via Canonical's public SSM parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`. This is a normal signed `ssm:GetParameter` call — no cross-account sharing/trust setup needed, just the `ssm:GetParameter` permission in the policy below.

**Minimal IAM policy** (replace `{{region}}` and `{{account-id}}`; the `RunInstances` resource list is broad — `instance/*`, `volume/*`, etc. — following AWS's own example policies, since Bivy doesn't know which subnet/AMI/etc. ids exist in your account ahead of time; narrow it further to a specific subnet/security-group ARN if you always launch into one):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DescribeAndListActionsRequireWildcard",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeAvailabilityZones"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LaunchInstances",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:{{region}}::image/ami-*",
        "arn:aws:ec2:{{region}}:{{account-id}}:instance/*",
        "arn:aws:ec2:{{region}}:{{account-id}}:volume/*",
        "arn:aws:ec2:{{region}}:{{account-id}}:network-interface/*",
        "arn:aws:ec2:{{region}}:{{account-id}}:subnet/*",
        "arn:aws:ec2:{{region}}:{{account-id}}:security-group/*",
        "arn:aws:ec2:{{region}}:{{account-id}}:key-pair/*"
      ]
    },
    {
      "Sid": "TagOnCreate",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "arn:aws:ec2:{{region}}:{{account-id}}:instance/*",
      "Condition": { "StringEquals": { "ec2:CreateAction": "RunInstances" } }
    },
    {
      "Sid": "TerminateInstances",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "arn:aws:ec2:{{region}}:{{account-id}}:instance/*"
    },
    {
      "Sid": "ReadCanonicalUbuntuAmiParameter",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:{{region}}::parameter/aws/service/canonical/*"
    }
  ]
}
```

For defense in depth, consider adding a `Condition` on `TerminateInstances` scoping it to instances tagged `bivy=ephemeral` (the adapter tags every instance it launches that way).

Known limitations for the first cut: launches into your account's **default VPC/subnet** (no `SubnetId`/`SecurityGroupId` params yet) — accounts without a default VPC will need that added before EC2 works; regions are a curated list of six (`us-east-1`, `us-west-2`, `eu-west-1`, `eu-central-1`, `ap-southeast-1`, `ap-northeast-1`) rather than all AWS regions, each needing its EC2 + SSM hosts allowlisted; instance types are a curated x86_64 "T"-family subset (Graviton/ARM64 is a natural follow-up, paired with the arm64 SSM AMI parameter).

UI safety notes:
- The token should be scoped to a disposable project/org where possible.
- The planned region, size, max TTL, and estimated cost are shown before provisioning.
- A **Destroy machine now** button and a visible teardown status are always available.
- Provider tokens are stored in the same secret path as other user-provided keys, never in session transcripts.

## Minimum implementation

- `EphemeralProvider` interface:
  - `createMachine({ region, image, size, ttl, sshKey })`
  - `bootstrapNode({ machine, enrollToken, repo, agent })`
  - `status(machineId)`
  - `destroy(machineId)`
- Provider adapters:
  - `hosted-fly` first if Bivy owns billing.
  - `byo-fly` and `byo-hetzner` next.
- Control-plane state:
  - machine id, provider, owner account, node id, session id, ttl, status, metadata only.
- Node bootstrap:
  - install Bivy
  - pair/enroll with account token
  - clone/select repo
  - select requested agent
  - auto-install the requested agent adapter when allowlisted
  - start managed session
- Teardown:
  - push branch / open PR / export artifacts if requested
  - regular GitHub-connected sessions use the same commit → push → PR delivery path; when work finishes Bivy should ask whether to create the PR instead of leaving the user to do it manually
  - wipe credentials and working dir
  - destroy machine

## Agent install behavior

Selecting an agent should be enough. If the selected runtime is allowlisted and not installed, Bivy should auto-install it in both ephemeral sessions and normal local/regular sessions. Manual install buttons remain as an escape hatch, not a prerequisite.

Implemented now for regular managed sessions/select paths where an allowlisted runtime installer exists (currently Claude Code SDK). CLI-only agents still need explicit safe installer specs before daemon-side auto-install should run them.

## Closing the cold-start gap (device-seeded model keys)

A brand-new ephemeral machine has no model credentials of its own. For most sessions that's fine — Bivy's **model-auth vault** syncs provider keys/OAuth records end-to-end across your nodes (see [`credential-sync.md`](credential-sync.md) §2), so a freshly-enrolled node just pulls them. But that sync is **node → node**: a requesting node asks the account for the wrapped vault key and *another node that already holds it* wraps it back. In the **true cold-start case — the ephemeral machine is your only node** (e.g. launched from a phone that owns no computer) — there is no peer to wrap from, so the vault can't seed and the agent boots with no model key.

The GitHub token already dodges this: it's held **on the device** and injected at launch (`BIVY_GITHUB_TOKEN`, see "Provisioning path"). We close the model-key gap the same way — **the device becomes the vault source** — but deliberately *not* through user-data.

### Why not bake the key into user-data

Cloud-init / user-data is **stored as instance metadata by the provider** (Fly/Hetzner/AWS) and must be readable by the VM in the clear at boot, so a secret placed there is exposed to your cloud account's metadata store (and, on the cold-start relay path, forwarded once through the control plane). Encrypting it doesn't help: the VM has to decrypt it, and any key shipped alongside in user-data is readable by the same host. For **BYO cloud** that exposure is arguably acceptable (it's your own account) — but it's avoidable, so we avoid it.

### How it works: push over the paired E2E channel

Keep user-data minimal (enrollment token + room key, as today). The machine boots and pairs to the relay, giving the device an **end-to-end-encrypted session channel** to it — the same one session traffic uses, which the relay and control plane cannot read. The device then pushes each held model key down that channel as an ordinary `provider.apiKey` write — **the exact frame Settings → Keys already uses** — and the node stores it in its vault. Properties:

- The key **never touches user-data**, so it's never in provider instance-metadata, and never forwarded through the cold-start control-plane relay.
- Trust model is identical to normal session traffic — no new boundary to reason about.
- The node's `provider.apiKey` handler also **re-pushes the model-auth vault to the control plane**, so once the first machine is seeded, *subsequent* nodes can sync from it the normal node→node way. The device seeding only has to happen for the cold start.

### Scope: API keys only

This path carries **model API keys** — opaque bearer secrets an agent can use from anywhere. It deliberately does **not** try to ship **agent-native OAuth / subscription logins** (Claude Code, Codex, Gemini CLI). Those are per-machine native logins (see [`credential-sync.md`](credential-sync.md) §4) and replaying them onto disposable machines is fragile — device/IP binding, refresh-token rotation, and subscription terms-of-service all bite. Steer OAuth-subscription agents toward an API key where the provider offers one; otherwise they still need a per-machine login.

### Implementation

- **Device store** — `createEphemeralModelKeyStore()` (`packages/core/src/ephemeral.ts`): IndexedDB on the device (`bivy-ephemeral-model-keys`), one `{ provider, key }` record per model provider. Same privacy model as the cloud provider tokens next to it — never sent to the control plane, never in user-data.
- **Seeding** — the web controller watches for coming **online on a node it launched** (a device-local `MachineStore` record) and, once the E2E transport is live, sends one `provider.apiKey` frame per held key. Guarded per session (so a reconnect doesn't re-push) and idempotent on the node regardless.
- **Configuration UI** — Settings → Ephemeral machines lets the user save the model keys to seed with, right beside the per-provider cloud tokens.

Still gated behind `EPHEMERAL_MACHINES_ENABLED` (`packages/web/src/flags.ts`) along with the rest of the ephemeral surface while the feature is built out.

## Resume after inactivity

Claude Code mobile appears to preserve the logical session while recycling the backing machine after long inactivity. Bivy should do the same by separating **session state** from **compute state**:

- Control plane keeps metadata only: logical session id, provider, repo slug, branch, runtime id, machine status, TTL, encrypted title, and pointers to node-owned artifacts.
- GitHub keeps durable code state: branch, commits, PR, issue links.
- The runtime/session store is snapshotted before teardown when the runtime supports it; otherwise Bivy can restore from the transcript/history plus repo branch and clearly mark the runtime as a resumed/fresh process.
- On resume, Bivy provisions a new ephemeral machine, bootstraps the same node/session id, reconnects GitHub credentials, fetches the branch, reinstalls/selects the same agent, restores the session transcript/runtime state, and continues.
- After teardown, the old machine should leave no credentials or repo checkout behind.

This gives the user the important continuity — conversation history, GitHub connection, branch/PR, selected agent/model, and session title — even when the actual VM is replaced.

## Recommended path

Start with **BYO Fly.io** or **BYO Hetzner** plus the existing account/node pairing. It avoids Bivy owning compute cost and abuse risk while proving the orchestration UX. Add Bivy-hosted machines only after quotas, billing, abuse controls, and teardown reliability are solid. **BYO AWS EC2** is now available on the same footing for users who already run infrastructure on AWS.

## Comparable providers (survey)

For context on where Fly/Hetzner/AWS sit relative to other options for short-lived, single-VM "run an agent session then destroy" compute:

| Provider | Auth | Provisioning shape | Boot time | Teardown | Cost (small instance) |
|---|---|---|---|---|---|
| Fly Machines | Bearer token | REST/JSON, one `POST .../machines` call | ~0.3–2s | Explicit delete, or auto-destroy config | ~$0.003/hr (shared-1x-256MB) |
| Hetzner Cloud | Bearer token | REST/JSON, one `POST /servers` call | ~10–20s (unofficial) | Explicit delete | ~€0.006/hr (CX22) |
| **AWS EC2** | SigV4-signed (access key + secret) | Query/XML, one `RunInstances` call | user-data starts ~15s in | Explicit terminate, or in-guest self-shutdown | ~$0.01/hr (t3.micro) |
| AWS Fargate/ECS | SigV4-signed | JSON, needs a cluster + task definition first, then `RunTask` | 20–60s unoptimized | Task stops on exit, or explicit stop | ~$0.012/hr (0.25vCPU/0.5GB) |
| GCP Compute Engine | Service account (OAuth2) | REST/gRPC, `instances.insert` | not benchmarked | Explicit delete | ~$0.02–0.05/hr (e2-small) |
| DigitalOcean | Bearer token | REST/JSON, `POST /v2/droplets` | not benchmarked | Explicit delete, per-second billing | ~$0.006/hr (smallest droplet) |
| E2B / Modal / Daytona | API key, SDK-first | SDK/thin REST, sandbox-as-a-service | 0.1–5s (sandbox primitives) | Explicit close, or timeout | ~$0.05/vCPU-hr |

AWS EC2 was chosen for the first non-Fly/Hetzner provider because it's the closest match to the existing "create a VM, run cloud-init user-data, destroy it" contract — see the AWS EC2 section above for why EC2 over Fargate/ECS specifically.
