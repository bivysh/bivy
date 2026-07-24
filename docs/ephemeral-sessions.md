# Ephemeral sessions

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

Implemented now: the remote UI's node selector has an **⚡ Ephemeral session** entry. Choosing it opens a provider picker (Fly.io, Hetzner Cloud, AWS EC2); picking a provider shows the inline quick guide below plus a token field. Saving stores the token **on the device** — in the PWA's IndexedDB (`bivy-ephemeral` DB, `provider-keys` store) via the shared `BivyEphemeralKeys` module — end to end. The token never touches the control plane or any node, and it isn't tied to a node, so a user can add it from their phone before they own any computer/server (the first machine they run can itself be ephemeral). Machine provisioning/teardown consumes this device-held token; see "Provisioning path" below.

The token field is a single opaque string as far as the store/UI are concerned — Fly and Hetzner treat it as a bearer token, while AWS's adapter parses it as `accessKeyId:secretAccessKey[:sessionToken]`. Nothing outside the adapter needs to know which shape a given provider uses.

When the user selects an ephemeral provider, show a short inline guide before asking for the key. Prefer direct links that open in a new tab.

## Provisioning path (implemented)

Because the token lives on the device, **all provider orchestration runs in the browser** (`packages/core/src/ephemeral.ts`, the `ProviderAdapter` implementations): each adapter builds the create/status/destroy requests, mint the bootstrap user-data, and drives the lifecycle. AWS additionally signs each request (SigV4) client-side before it's sent — see "Adding a new provider" below. The browser can't call the provider APIs directly (no CORS), so it asks a **transport** to run one allowlisted HTTPS request on its behalf:

- **cloud relay (the wired path today):** the browser posts the request to the control plane's `POST /api/ephemeral/exec` (`requireUser`), which forwards it once and **never stores or logs it**. This lets a phone launch its first machine with no node online, at a softer guarantee (the token is TLS-terminated in-flight at the control plane). The web controller uses this transport for every provider call (`packages/web/src/store/controller.ts`, `cloudExec`).
- **node-broker (E2E, node side only so far):** the *intended* default once an account has a node online — the browser would send an `ephemeral.exec` frame over the E2E relay and the node runs the request (`src/ephemeral-exec.ts`), so the control plane never sees the token. The node-side handler exists, but **no client emits the frame yet**, so this path is not active. Tracked in `packages/web/STATUS.md`. Until it lands, even the with-a-node case goes through the cloud relay above.

Both proxies enforce the same host allowlist as the SSRF guard: `api.hetzner.cloud`, `api.machines.dev`, `api.fly.io`, plus per-region `ec2.<region>.amazonaws.com`/`ssm.<region>.amazonaws.com` hosts for AWS. It's kept in lock-step across three copies — `ALLOWED_HOSTS` in `packages/core/src/ephemeral.ts`, `EPHEMERAL_ALLOWED_HOSTS` in `src/ephemeral-exec.ts`, and the control plane's own copy in `services/control-plane/src/index.ts` — since the control plane is deliberately kept dependency-light and doesn't import `@bivy/core`.

Launch flow (browser):

1. Enroll a fresh `nodeId` with the control plane (`POST /nodes/enroll`, account session) → enrollment token.
2. Mint a 32-byte room key; keep it on the device (for reach) and bake it into the machine's `relay.json`. On the node-broker path the relay/control plane never see it.
3. Build cloud-init user-data that installs Bivy, writes `/etc/bivy/relay.json`, and arms a **self-shutdown at TTL** so a forgotten machine can't bill forever.
4. `provision()` via the chosen transport; store the machine record on the device (`bivy-ephemeral` → `machines`) so it can be listed/destroyed later.
5. The node boots, pairs over the relay, and appears in the node list; the browser already holds its room key, so sessions are reachable.

Teardown: a **Destroy now** button runs `destroy()` via the same transport and deregisters the node. TTL self-shutdown is the backstop when the device is gone. Machine records are device-local only — the control plane holds none.

Caveat: the adapters are written against each provider's documented API shape and are unit-tested via an injected transport (`packages/core/test/ephemeral-aws.test.ts`, `packages/core/test/ephemeral-stores.test.ts`) plus the node SSRF proxy (`test/ephemeral-exec.test.ts`), but live end-to-end provisioning still needs a real token/account per provider to confirm.

### Metadata hardening (AWS)

The bootstrap user-data carries the relay enrollment token and the room key, so the EC2 adapter launches instances with **IMDSv2 required** (`MetadataOptions.HttpTokens=required`) and the metadata **hop limit pinned to 1**. That closes the classic SSRF path to `169.254.169.254` (an agent coaxed into fetching the metadata URL can't read user-data without a PUT-minted session token, and a proxied/containerized request can't reach IMDS at all). Cloud-init on the host still reads user-data over IMDSv2 at boot, so provisioning is unaffected. Note this does not stop a *local root* process on the box from reading user-data; fully removing standing secrets from user-data (deliver the room key over the E2E relay post-boot instead) is the tracked follow-up. Fly/Hetzner have no equivalent metadata-token knob; the same follow-up covers them.

### Reliability: work-item leases

A GitHub/Slack work item claimed by an ephemeral runner used to be stranded in `claimed` forever if the machine was terminated (at its TTL, or any crash) before it finished — the control plane holds no GitHub write credential, so the issue would simply go silent. The control plane now leases claims: a running node renews its lease on an interval (`POST /node/work/:id/heartbeat`), and a background sweep (`requeueExpiredWorkItems`, cadence/TTL via `WORK_LEASE_MS`) returns any claim that goes un-renewed past the lease back to `pending` so another node or a fresh machine can pick it up. A crash-looping item is dead-lettered after `WORK_MAX_ATTEMPTS` requeues rather than retried forever. This makes ephemeral GitHub runs safe against the TTL-vs-claim race even though the machine's death is expected. See `services/control-plane/src/{store,postgres-store,index}.ts` and `src/control-plane-tasks.ts`.

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
- Tell users the token should be scoped to a disposable project/org where possible.
- Show the planned region, size, max TTL, and estimated cost before provisioning.
- Include a **Destroy machine now** button and a visible teardown status.
- Store provider tokens in the same secret path as other user-provided keys; never in session transcripts.

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
