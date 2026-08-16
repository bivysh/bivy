# Ephemeral sessions

> **Status: enabled with an emergency kill switch.** Product access is gated by
> provider onboarding and per-account hosted opt-in. Setting the web/control-plane
> `EPHEMERAL_MACHINES_ENABLED` flag to exact `0` stops new launches; cleanup and
> reconciliation continue so the kill switch cannot strand billable resources.

Ephemeral sessions are short-lived Bivy nodes created for one task/session. Interactive prompts, files, tool output, credentials, and agent transcripts remain on the ephemeral machine and are destroyed with it unless the user explicitly exports a branch/PR/artifact. The control plane stores routing/outcome metadata; if the task originated from Slack or a generic webhook, that inbound instruction follows the separately documented automation boundary in [security-model.md](security-model.md#what-the-control-plane-sees).

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

Implemented now: the remote UI's node selector has an **⚡ Ephemeral machine** entry. Users can save multiple named setups per provider, each with its own region, size, TTL, repository, and optional **destroy when the agent finishes** policy. Finish-triggered teardown is evaluated by the ephemeral daemon after `agent_end` (including turns that create a PR); a watching device may also issue the same provider-correct teardown as a fast path, and the TTL always remains a safety fallback if the device or daemon disappears. These setups appear in the node selector like offline persistent nodes; selecting one opens a pre-filled launch view, and the setup remains after each short-lived machine expires. The provider token is shared by that provider's setups and stored **on the device** — in the PWA's IndexedDB (`bivy-ephemeral` DB, `provider-keys` store). Saved setups use the device-local `setups` store. Neither tokens nor setups touch the control plane, so a user can configure them from a phone before owning a computer/server.

The token field is a single opaque string as far as the store/UI are concerned — Fly and Hetzner treat it as a bearer token, while AWS's adapter parses it as `accessKeyId:secretAccessKey[:sessionToken]`. Nothing outside the adapter needs to know which shape a given provider uses.

When the user selects an ephemeral provider, show a short inline guide before asking for the key. Prefer direct links that open in a new tab.

For an account with no node yet, the app presents one complete four-step path:
connect the cloud provider, save a model API key, save a fine-grained GitHub
token for repository/PR work, then choose and launch the runner. GitHub account
sign-in remains deliberately minimal-scope and does not grant repository access.
The launch button stays disabled until both runner credentials are available,
avoiding a machine that boots successfully but cannot run the advertised
issue-to-PR flow. The device-local GitHub
token is included in the runner bootstrap; model keys wait for the E2E channel
and are then seeded into the node vault.

## Provisioning path (implemented)

Because the token lives on the device, **all provider orchestration runs in the browser** (`packages/core/src/ephemeral.ts`, the `ProviderAdapter` implementations): each adapter builds the create/status/destroy requests, mint the bootstrap user-data, and drives the lifecycle. AWS additionally signs each request (SigV4) client-side before it's sent — see "Adding a new provider" below. The browser can't call the provider APIs directly (no CORS), so it asks a **transport** to run one allowlisted HTTPS request on its behalf:

- **node-broker (default, end-to-end):** when the account has a node online, the browser sends an `ephemeral.exec` frame over the E2E relay; the node runs the request (`src/ephemeral-exec.ts`) and returns the result. The control plane never sees the token.
- **cloud relay (cold start):** with no node online, the browser posts the request to the control plane's `POST /api/ephemeral/exec` (`requireUser`), which forwards it once and **never stores or logs it**. This lets a phone launch its first machine, at a softer guarantee (the token is TLS-terminated in-flight at the control plane).

Both proxies enforce the same host allowlist as the SSRF guard: `api.hetzner.cloud`, `api.machines.dev`, `api.fly.io`, plus per-region `ec2.<region>.amazonaws.com`/`ssm.<region>.amazonaws.com` hosts for AWS. It's kept in lock-step across three copies — `ALLOWED_HOSTS` in `packages/core/src/ephemeral.ts`, `EPHEMERAL_ALLOWED_HOSTS` in `src/ephemeral-exec.ts`, and the control plane's own copy in `services/control-plane/src/index.ts` — since the control plane is deliberately kept dependency-light and doesn't import `@bivy/core`.

Launch flow (browser):

1. Enroll a fresh `nodeId` with the control plane (`POST /nodes/enroll`, account session) → enrollment token.
2. Mint a 32-byte room key; keep it on the device (for reach) and bake it into the machine's `relay.json`. On the node-broker path the relay/control plane never see it.
3. Build the bootstrap that installs Bivy, writes `/etc/bivy/relay.json` + `/etc/bivy/start.sh`, **starts the daemon**, and arms a **self-shutdown at TTL** so a forgotten machine can't bill forever. The installer only *installs* Bivy — a headless, pre-enrolled machine has no TTY for `bivy setup`, so `start.sh` (`exec bivy start`, reading the baked `relay.json`) is what actually brings the node online. This is one intent in two forms: `buildBootstrapUserData()` emits cloud-init for VM providers; `bootstrap: BootstrapOpts` is handed to the adapter for providers that can't run cloud-init (see Fly below).
4. `provision()` via the chosen transport; store the machine record on the device (`bivy-ephemeral` → `machines`) so it can be listed/destroyed later.
5. The node boots, pairs over the relay, and appears in the node list; the browser already holds its room key, so sessions are reachable.

**VM vs. container bootstrap.** Hetzner and EC2 boot a full cloud image: cloud-init runs the `#cloud-config`, and the daemon is launched as a transient `systemd-run` unit that outlives cloud-init's own unit. Fly is different — a Fly Machine is an OCI image (`ubuntu:24.04`) in a Firecracker microVM, not a cloud-init VM. It runs neither cloud-init *nor* the image's would-be default `/bin/bash` for more than an instant, and the bare image ships no `curl`. So the Fly adapter (`flyInit`) writes `relay.json` + `start.sh` as machine `files`, installs `curl` then Bivy, and runs `bivy start` as a **blocking foreground init process** under a TTL `timeout`. `auto_destroy` then means "destroy when the agent finishes" literally: the machine is reaped only once that foreground daemon exits. (Skipping the foreground process was the original bug — the machine self-destructed on boot before Bivy ever installed.)

Teardown: a **Destroy now** button runs `destroy()` via the same transport and deregisters the node. TTL self-shutdown is the backstop when the device is gone. Machine records are device-local only — the control plane holds none.

Caveat: the adapters are written against each provider's documented API shape and are unit-tested via an injected transport (`packages/core/test/ephemeral-aws.test.ts`, `packages/core/test/ephemeral-stores.test.ts`) plus the node SSRF proxy (`test/ephemeral-exec.test.ts`), but live end-to-end provisioning still needs a real token/account per provider to confirm.

### Live provider smoke

The manual `Ephemeral live smoke` workflow exercises a deployed control plane and
a dedicated test account through public account APIs: validate the provider
credential, enable hosted provisioning, create and route to a temporary config,
enqueue a real automation run, wait for `firstAgentEventAt`, report the cold-start
milestones, destroy the runner, and assert its hosted inventory is empty. Cleanup
runs even after a timeout or SLO failure. The protected `ephemeral-live-smoke`
GitHub environment must provide `BIVY_SMOKE_CONTROL_PLANE_URL`,
`BIVY_SMOKE_ACCOUNT_TOKEN`, and the selected provider secret. Use an account with
no non-smoke routing or runners: the workflow deliberately disables hosted
provisioning and restores shared routing during cleanup. Enable the optional
10-second assertion only for a prebuilt/ready-capacity lane advertised as fast.

### Ready capacity

A saved stable BYO-cloud config can opt into one account-owned ready runner. The
global hosted reconciler creates it before work arrives; it is enrolled to that
account and serves only its unique empty queue label. On work arrival the control
plane atomically changes its purpose from `ready-capacity` to `queue-default`,
routes waiting work to its label, and replenishes in the background. A Postgres
lease serializes reconcile, claim, and launch across control-plane replicas.

Capacity is never shared across customers. Managed-compute providers use their
native fast-start or suspend path, and normal TTL/provider teardown remains the
bill-safety backstop. A standby with less than five minutes remaining is deleted
at the provider before replacement and is never claimed; failed deletion remains
tracked and blocks replacement rather than risking double billing.

The hosted-runner settings inventory derives a lifecycle phase from durable
milestones (`provisioning`, `hydrating`, `ready`, `claimed`, or `working`) and
promotes any provider teardown/reconcile failure to `teardown failed`. Each row
shows an approximate accrued/max compute cost when the catalog knows the selected
size's hourly rate, plus TTL and a jump to its audit evidence. These are estimates,
not invoices; the user's provider bill remains authoritative for discounts,
storage, egress, taxes, and live price changes.

## Adding a new provider

The whole point of `ProviderAdapter` is that adding a provider is additive — no shared dispatch/call site (the UI, the controller, `launchEphemeralMachine`/`destroyEphemeralMachine`/`listEphemeralSizes`) needs to change. It only needs to know a provider's `id` string. Checklist, using the AWS adapter as the reference example:

1. **Catalog entry** — add an `EphemeralProviderCatalog` object to `EPHEMERAL_PROVIDERS` in `packages/core/src/ephemeral.ts`: `id`, `name`, `computeClass` (`byo-cloud` or `managed-compute`), `maturity` (`stable` or `experimental`), `tokenLabel` (what the UI's single text field is asking for — one bearer token, or a composite like AWS's `accessKeyId:secretAccessKey`), `blurb`, `steps` (numbered setup copy), and `links` (opens in a new tab). This alone makes the provider selectable and show its guide — the UI (`packages/web/src/components/Ephemeral.tsx`) renders straight from the catalog. Managed agent/sandbox clouds default to experimental; supporting one must not make Bivy's portable checkpoint format optional.
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
- The planned region, size, max TTL, and an **indicative cost estimate** are shown before provisioning. The estimate is `pricePerHour × TTL` in the provider's currency (`ephemeralCostHint` in `packages/core/src/ephemeral.ts`); it's a hint, not an invoice — the provider's live bill is authoritative and storage/egress/taxes aren't included. Static per-size prices ship in the size catalogs; Hetzner's live `listSizes` overrides them with the token's real prices.
- A **Destroy machine now** button and a visible teardown status are always available. If the provider's destroy call fails, the machine record is **kept** (not silently forgotten) so teardown can be retried and a live, billing machine is never orphaned; the TTL self-shutdown remains the eventual backstop.
- The TTL self-shutdown is armed with a `systemd-run` transient timer (surviving cloud-init), falling back to `at` then a detached `setsid` sleep, so a forgotten machine self-halts even on a minimal base image.
- Provider tokens are stored in the same secret path as other user-provided keys, never in session transcripts.

### Fly Sprites (suspend-to-zero, "machines that remember")

[Fly Sprites](https://sprites.dev) are a different lifecycle from the destroy-when-done providers above, and the first realisation of the [Resume after inactivity](#resume-after-inactivity) design below. A Sprite is a stateful Linux box that **auto-suspends to ~$0 when idle** and **resumes with its full filesystem and memory intact** — so instead of tearing the machine down and rebuilding it, Bivy keeps it and simply wakes it when you reopen its session.

Copy for the UI:

1. Sign in at <https://sprites.dev> and open your account page.
2. Create an API token (or run `sprite org auth` in the Sprites CLI).
3. Paste the token into Bivy. It stays on this device like the other provider tokens.

How the adapter fits the model (`sprites` in `packages/core/src/ephemeral.ts`):

- **Bearer token, REST/JSON, one allowlisted host** (`api.sprites.dev`) — same shape as Fly Machines/Hetzner, so it drops into `ProviderAdapter` with no dispatch changes.
- **No cloud-init.** A Sprite is bootstrapped by registering the daemon as a supervised **service** over the REST API: `POST /v1/sprites` (create), `PUT /v1/sprites/{name}/services/bivy` (the service — its script writes `relay.json` from an env var, installs Bivy once, then runs `bivy start` in the foreground), then `POST .../services/bivy/start`. The install persists across suspends via the Sprite's own storage, so only the first boot pays for it.
- **Wake = start the service.** There's no explicit suspend/resume REST endpoint — a Sprite resumes on any request routed to it. Our HTTPS exec proxy can't hold a WebSocket, so the wake path is the single request `POST .../services/bivy/start`, which both resumes the cold Sprite and ensures the daemon is running so it re-dials the relay. It's exposed as the adapter's optional `wake` method and driven by `wakeEphemeralMachine` / `controller.resumeAndConnectNode`.
- **Kept, never TTL-destroyed.** `suspendsWhenIdle: true` on the adapter tells the lifecycle to skip the TTL self-destruct and the destroy-on-finish teardown (`maybeTeardownFinishedEphemeral`) — destroying a Sprite would throw away the memory that is the whole point. Cost control is the suspend-to-zero, not a TTL. **Destroy machine now** still deletes the Sprite (and its stored state) explicitly.

UI: a Sprites setup shows in the node switcher like any other. When it has suspended it appears as a **Suspended** row; tapping it wakes the Sprite (`resumeAndConnectNode`) and waits for it to rejoin the relay before opening the session, rather than the destroy/relaunch other providers need. The launch/setup forms drop the TTL and teardown-on-finish controls for Sprites and show a suspend explainer plus a "≈ $x/hr while active · ~$0 while suspended" cost hint.

First-cut limitations: a curated region list (Fly region codes) and a small set of `(cpus, ram)` sizes; the `status` mapping normalises Sprites' running/warm/cold to Bivy's `running`/`stopped`; live end-to-end still needs a real Sprites token to confirm (the adapter is unit-tested via an injected transport in `packages/core/test/ephemeral-sprites.test.ts`).

> **Unverified assumption — does an idle Sprite actually suspend while the daemon runs?** The whole "~$0 when idle" value depends on Fly's idle-detection, which lives in the external Sprites service, not this repo. Meanwhile the daemon holds a **persistent outbound relay WebSocket and pings it every 30s** (`HEARTBEAT_INTERVAL_MS` in `src/relay-client.ts`), plus 30–60s control-plane poll timers — with **no quiet-mode or throttle** anywhere. If Sprites counts any open connection or outbound traffic as "active", a Sprite would never suspend and the cost benefit evaporates. It *likely* keys off **inbound** routed requests (consistent with "a Sprite resumes on any request routed to it" above), in which case the outbound socket is harmless — but this is unconfirmed and must be checked against a live Sprite. If it does not suspend, the daemon needs a suspend-aware quiet mode that drops the relay socket and pauses the poll timers when a session is idle. (E2B below sidesteps this entirely: its pause is a deterministic server-enforced timeout, not an idle heuristic.)

### E2B

[E2B](https://e2b.dev) is the second managed-sandbox substrate (`e2b` in `packages/core/src/ephemeral.ts`), a sibling to Fly Sprites: a `X-API-Key` REST API (host `api.e2b.app`) that creates a Firecracker microVM for agent workloads. Its lifecycle is enforced **server-side by E2B** — every sandbox carries a `timeout`, and when it elapses E2B either kills the sandbox or, with `autoPause`, pauses it to ~$0 with full filesystem + memory state, resumable (~1s) with everything intact. Bivy models it as a suspend-when-idle provider (`suspendsWhenIdle: true`, `wake` = resume), so it reuses the same kept-not-destroyed lifecycle and UI as Sprites.

Copy for the UI:

1. Sign in at <https://e2b.dev> and open your dashboard.
2. Go to **Team → API Keys** and create a key.
3. Paste the key into Bivy. It stays on this device like the other provider tokens.

Why E2B is attractive here: its pause is **deterministic** (driven by the server-enforced timeout), not by an unverified idle heuristic, so it holds regardless of what the daemon's relay socket is doing — the opposite of the Sprites caveat above.

**Status: prototype.** The adapter is written against E2B's documented REST shape and unit-tested with an injected transport (`packages/core/test/ephemeral-e2b.test.ts`), but three things must be resolved before it ships as GA:

- <a id="e2b"></a>**Bootstrap needs a published template.** E2B runs a *template's* start command and (unlike Sprites) can't take an arbitrary boot script at create time. So this depends on published `bivy-<size>` E2B templates that install Bivy and run `bivy start`, reading relay enrollment from the env vars we pass at create (`bivyNodeEnv`). That template artifact is tracked separately, like the install script.
- **API shape needs live confirmation.** Endpoint paths and field names (`/v2/sandboxes`, `autoPause`, `envVars`, `sandboxID`, `/resume`) are from E2B's documented surface and need a real key to confirm.
- **Timeout is wall-clock, not activity-based.** To keep a long *active* session warm, someone must refresh the timeout (the device while online, or a control-plane keepalive) — the same lifecycle question the bring-your-own-cloud lane tracks. The prototype sets a generous fixed window and lets `autoPause` preserve state if it elapses mid-session.

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

## Sub-10-second runner fast lane

The generic Ubuntu bootstrap remains the compatibility lane: it may install OS
packages, Node, Bivy, and agent dependencies after the provider accepts the VM,
so it cannot satisfy a request-to-agent target under ten seconds. The fast lane
uses the credential-free image built by
`deploy/Dockerfile.ephemeral-runner` and published as
`ghcr.io/bivysh/bivy-ephemeral-runner:sha-<commit>` by
`.github/workflows/ephemeral-runner-image.yml`.

The image contains only public runtime material (Node, Bivy, git, SSH/certificate
tools, and installed agent dependencies). Enrollment tokens, E2E room keys,
model/provider credentials, repo selection, and restore state are injected at
claim/launch time. A saved ephemeral config may set the provider-native `image`
identifier: the GHCR reference for Fly, a snapshot/image id for Hetzner, or an AMI
id for AWS. E2B already uses versioned `bivy-<size>` templates; Sprites pays the
install once and persists it across suspends.

Every bootstrap now checks `command -v bivy` first. A prebuilt image starts the
daemon immediately; a generic/old image falls back to the existing installer.
This makes image rollout reversible and prevents a missing image pipeline from
removing the compatibility path. Cold-start success is still measured from
request to the first agent event—not image pull or provider “running.” A warm
ready-capacity pool is the next latency layer after this image baseline.

## Closing the cold-start gap (device-seeded model keys)

A brand-new ephemeral machine has no model credentials of its own. For most sessions that's fine — Bivy's **model-auth vault** syncs provider keys/OAuth records end-to-end across your nodes (see [`credential-sync.md`](credential-sync.md) §2), so a freshly-enrolled node just pulls them. But that sync is **node → node**: a requesting node asks the account for the wrapped vault key and *another node that already holds it* wraps it back. In the **true cold-start case — the ephemeral machine is your only node** (e.g. launched from a phone that owns no computer) — there is no peer to wrap from, so the vault can't seed and the agent boots with no model key.

> **Subscription OAuth on ephemeral runners.** The node→node sync above carries the *whole* vault — model API keys **and** the supported subscription-OAuth logins (Anthropic Claude Code, OpenAI Codex; see [`credential-sync.md`](credential-sync.md) §2/§4). So an ephemeral runner with **any** peer node online receives those logins too, and its agent runs project them the normal way (`CLAUDE_CODE_OAUTH_TOKEN`, Codex `auth.json`) — no extra path needed. To keep this fast for a machine that may only live a minute, a node's vault-key request now **wakes the account's peers over the relay** (event-driven) so one answers within seconds instead of on its 30s poll, and the requester fast-retries until the wrapped key lands. This is **peer-only**: the wrapped key is always answered by another node over the E2E wrap, so no subscription token or vault key ever transits the device or control plane in the clear. Only the **lone-node** cold start below (no peer online at all) falls back to API-keys-only.

The GitHub token already dodges this: it's held **on the device** and injected at launch (`BIVY_GITHUB_TOKEN`, see "Provisioning path"). We close the model-key gap the same way — **the device becomes the vault source** — but deliberately *not* through user-data.

### Why not bake the key into user-data

Cloud-init / user-data is **stored as instance metadata by the provider** (Fly/Hetzner/AWS) and must be readable by the VM in the clear at boot, so a secret placed there is exposed to your cloud account's metadata store (and, on the cold-start relay path, forwarded once through the control plane). Encrypting it doesn't help: the VM has to decrypt it, and any key shipped alongside in user-data is readable by the same host. For **BYO cloud** that exposure is arguably acceptable (it's your own account) — but it's avoidable, so we avoid it.

### How it works: push over the paired E2E channel

Keep user-data minimal (enrollment token + room key, as today). The machine boots and pairs to the relay, giving the device an **end-to-end-encrypted session channel** to it — the same one session traffic uses, which the relay and control plane cannot read. The device then pushes each held model key down that channel as an ordinary `provider.apiKey` write — **the exact frame Settings → Keys already uses** — and the node stores it in its vault. Properties:

- The key **never touches user-data**, so it's never in provider instance-metadata, and never forwarded through the cold-start control-plane relay.
- Trust model is identical to normal session traffic — no new boundary to reason about.
- The node's `provider.apiKey` handler also **re-pushes the model-auth vault to the control plane**, so once the first machine is seeded, *subsequent* nodes can sync from it the normal node→node way. The device seeding only has to happen for the cold start.

### Scope: API keys only

This **device-seed** path (the lone-node fallback) carries **model API keys** only — opaque bearer secrets an agent can use from anywhere. It deliberately does **not** ship **agent-native OAuth / subscription logins** through the device: putting subscription refresh tokens at rest in the browser would widen the trust boundary, and replaying them onto disposable machines is fragile — device/IP binding, refresh-token rotation, and subscription terms-of-service all bite.

Note this scope limit applies **only** to the lone-node cold start. When the account has any other node online, the supported subscription logins (Anthropic Claude Code, OpenAI Codex) **do** reach the ephemeral runner — via the peer vault sync described above, kept fast by the event-driven wake — with the tokens staying E2E-wrapped node→node. If you truly have no peer node and need a subscription-only agent on a fresh machine, steer it toward an API key where the provider offers one; otherwise it waits for a peer to come online.

> **Node-less inheritance (hosted).** Hosted custody is explicit per credential. Marking **Allow unattended runs** creates a separate filtered model-auth ciphertext containing only granted stored credentials and encrypts it under a different key from the peer-wrapped account vault. The control plane seals that hosted key at rest in `hosted_model_auth_keys`; possessing it cannot decrypt the ordinary account vault. A lone hosted ephemeral reads `hostedVault` + `hostedKey`, while ordinary nodes continue to read the CP-blind peer vault. Revoking the grant removes the item from snapshots used by future runners (as with any credential already delivered to a machine, rotate at the provider if that machine may be compromised). Non-hosted accounts stay fully peer-wrapped. The **app-brokered login relay** (`provider.oauth.start` / `provider.oauth.code`) still completes subscription sign-in on a node; the user must separately grant that item for unattended use. Covered by `services/control-plane/test/hosted-model-auth-escrow.test.ts`, `test/credential-sync-policy.test.ts`, and `oauth-login-sweep.test.ts`.

### Implementation

- **Device store** — `createEphemeralModelKeyStore()` (`packages/core/src/ephemeral.ts`): IndexedDB on the device (`bivy-ephemeral-model-keys`), one `{ provider, key }` record per model provider. Same privacy model as the cloud provider tokens next to it — never sent to the control plane, never in user-data.
- **Seeding** — the web controller watches for coming **online on a node it launched** (a device-local `MachineStore` record) and, once the E2E transport is live, sends one `provider.apiKey` frame per held key. Guarded per session (so a reconnect doesn't re-push) and idempotent on the node regardless.
- **Configuration UI** — Settings → Ephemeral machines lets the user save the model keys to seed with, right beside the per-provider cloud tokens.

Provider onboarding now performs a read-only authentication check before a
device-local token is saved. Hosted provisioning records a token fingerprint
only after `/account/hosted-provisioning/validate-provider` succeeds, and refuses
automatic launch if the stored token does not match that validation. Account
`hosted.enabled` is the product opt-in; `EPHEMERAL_MACHINES_ENABLED=0` (and the
web build equivalent) remains an emergency switch for stopping new launches.

## Resume after inactivity

Claude Code mobile appears to preserve the logical session while recycling the backing machine after long inactivity. Bivy should do the same by separating **session state** from **compute state**:

- Control plane keeps metadata only: logical session id, provider, repo slug, branch, runtime id, machine status, TTL, encrypted title, and pointers to node-owned artifacts.
- GitHub keeps durable code state: branch, commits, PR, issue links.
- The runtime/session store is snapshotted before teardown when the runtime supports it; otherwise Bivy can restore from the transcript/history plus repo branch and clearly mark the runtime as a resumed/fresh process.
- On resume, Bivy provisions a new ephemeral machine, bootstraps the same node/session id, reconnects GitHub credentials, fetches the branch, reinstalls/selects the same agent, restores the session transcript/runtime state, and continues.
- After teardown, the old machine should leave no credentials or repo checkout behind.

This gives the user the important continuity — conversation history, GitHub connection, branch/PR, selected agent/model, and session title — even when the actual VM is replaced.

**Realised natively by Fly Sprites.** The [Fly Sprites](#fly-sprites-suspend-to-zero-machines-that-remember) provider gives this behaviour for free without Bivy having to snapshot/rebuild anything: the Sprite **suspends to ~$0 when idle and resumes with its filesystem *and* memory intact**, so the daemon process, runtime/session store, repo checkout, and agent all come back exactly where they were. Bivy's only job is to **wake** the suspended Sprite when the user reopens the session (`controller.resumeAndConnectNode` → the adapter's `wake` → the daemon re-dials the relay). The snapshot/rebuild path above remains the fallback for the destroy-when-done providers (Fly Machines/Hetzner/AWS), which can't preserve compute state across a teardown.

## Server-side teardown (device-independent)

Teardown was historically **device-driven**: `controller.maybeTeardownFinishedEphemeral` issued the destroy from the launching browser after `agent_end`, using the device-local provider token, with the machine's TTL self-shutdown as the only server-side backstop. That's why the launch UI warned that "destroy when the agent finishes" **requires this device to stay online** — and it left background automation workers (no device at all) burning their whole TTL idle.

Teardown authority now lives on the machine and the control plane, so it works for sessions **and** automations with no device or persistent node online:

- **The machine's own daemon self-terminates once idle.** The bootstrap tags a destroy-lane machine with `BIVY_EPHEMERAL=1` (+ provider, TTL, and `BIVY_TEARDOWN_ON_FINISH` mirroring the device toggle — see `bivyBootstrapExports` in `packages/core/src/ephemeral.ts`; suspend-to-zero providers are never tagged, they're kept). The daemon evaluates a **pure quiet condition** (`shouldSelfTeardown` in `src/ephemeral-teardown.ts`): no session running a turn, no device attached (`remoteActive`), no in-flight queue work, sustained past a grace — short after an agent finishes, else the idle window — and only after the machine has been busy at least once (never reaps a freshly-booted box). It's evaluated on `agent_end` and on the idle sweep (`closeIdleSessions`).
- **The teardown action is provider-correct.** Fly: the daemon exits → `auto_destroy` reaps the init process. EC2: `shutdown -h now` → `InstanceInitiatedShutdownBehavior: terminate`. Hetzner: exiting can't reap the (still-billing) server, so the daemon posts a non-secret `POST /node/settled` and the control plane destroys it.
- **The control plane is the backstop.** `/node/settled` and the lazy `reconcileHostedMachines` (`services/control-plane/src/ephemeral-provisioner.ts`) now **actively `destroyEphemeralMachine`** for hosted machines whose provider doesn't self-reap (Hetzner), using the `hosted.providerTokens` the CP already holds — idempotent/404-tolerant, so it races the daemon and the device fast-path harmlessly.

| Provider | Teardown once idle, no device online | Credential needed server-side |
|---|---|---|
| Fly Machines | daemon exits → `auto_destroy` | none |
| EC2 | daemon `shutdown -h now` → terminate | none |
| Hetzner (hosted) | daemon `/node/settled` plus global provider reconciliation | hosted provider token |
| Hetzner (device-launched) | **refused** — guest shutdown only powers off the still-billable server | — |
| Fly Sprites / E2B | n/a — kept and suspended, never destroyed on finish | — |

The device fast path (`maybeTeardownFinishedEphemeral`) is kept for snappy teardown while a device *is* watching; it's just no longer the sole authority. A global control-plane timer scans every account with a tracked machine or active launch attempt every five minutes, independently of new work, and retries provider deletion. Cleanup deliberately ignores the new-launch kill switch.

## Resumability with no persistent nodes

"Resume" always means *reach the machine that still physically holds the state* — the control plane stores E2E-encrypted **metadata only** (session index title, ownership node-ids), never the transcript, files, or runtime. So resumability is a pure function of whether some machine still has the session and whether *this* device can reach it. Today:

| Case | Resumable? | Why |
|---|---|---|
| Sprites/E2B, **same device** that launched it | **Yes** | Machine is kept (never torn down), wakes with full FS + memory. Resume = `wake`. |
| Sprites/E2B, **different/offline device** | **No (state alive but unreachable)** | Provider token + machine record are device-local; a second device can't wake it. (Room key is *not* the blocker — see below.) |
| Fly Machines/Hetzner/EC2 **after teardown** | **Yes, reconstructed (live smoke pending)** | A sealed transcript + git checkpoint survives in the control plane and a new machine reuses the node/session key. Native runtime process state is not preserved. |
| Fresh device, **zero nodes online** | **No** | Session metadata/title is listed, but opening needs a live node to connect to over the relay. |
| Session replication (`session-replication.md`) | **Only to your other online node** | Full-transcript warm standby, node→node, manual promotion, **off by default** — evaporates if *all* nodes go away. |
| Hosted auto-provision (`ephemeral-provisioner.ts`) | **New work and targeted rebuilds** | Server-side and device-offline; an existing-session item reuses the escrowed room key and boots with `BIVY_RESTORE`. |

Two gaps follow, tracked below. Both ultimately need the same hard primitive — encrypting a secret so **only the account, never the control plane, can read it** on a fresh device — which is the same key-availability problem as [Closing the cold-start gap](#closing-the-cold-start-gap-device-seeded-model-keys).

### Gap A — cross-device resume of a suspend-to-zero machine

Make a Sprite/E2B sandbox that device A launched resumable from device B. Three things are device-local, but they are **not** equally hard:

- **Room key — not actually a blocker.** The per-node room key is random and device-local at mint (`crypto.getRandomValues` in `launchEphemeralMachine`, stored in `localStorage["bivy_keys"]`), but it is **re-delivered to any account device by the existing pairing handshake** once the node is online: `sendAccountPair` → the node replies with the room key ECDH+HKDF-wrapped to the requesting device's pubkey (`transport-relay.ts`, `docs/credential-sync.md`). So waking the machine is sufficient to make it reachable — **no room-key sync required.**
- **Machine provider identity — the wake blocker (P1, non-secret).** `resumeAndConnectNode` looks up the `EphemeralMachine` in device-local IndexedDB (`bivy-ephemeral-machines`) to know *what* to wake. Device B's store is empty, so it silently skips the wake and hangs connecting to an off-relay node. Device B *does* see the node in the account `/nodes` registry, but not its provider machine id. **Fix: carry the non-secret machine identity (`provider`, machine id, `app`, region) on the enrolled `eph-*` node registry entry**, and reconstruct an `EphemeralMachine` from it on device B. A Fly machine id / E2B sandbox id is not a credential — no posture change.
- **Provider token — the real secret work (P2). Implemented.** Waking still needs the provider token, which lived only in device A's IndexedDB (`provider-keys`). P2 adds an **opt-in E2E device vault** (`createDeviceVaultKeyStore`, `packages/core/src/device-vault.ts`): the tokens map is sealed under a per-account vault key, and the vault key is ECDH-wrapped to each account device's X25519 pubkey (`wrapKeyFor(..., "device-vault")` + `seal`/`open`, `HKDF_INFO.deviceVault`). The control plane stores only ciphertext + per-device wrapped keys — new `device_vault*` tables + `requireUser` `/device-vault*` endpoints mirroring the node model-auth vault. It backs `EphemeralKeyStore.getToken` (wired at `controller.ts`), so `launchEphemeralMachine`/`wakeEphemeralMachine`/`destroyEphemeralMachine` work unchanged; a second device's `getToken` transparently pulls the synced token. **Opt-in** (Settings → "Sync provider tokens across my devices", off by default); single-device/opt-out users are unaffected. *Alternative not taken:* a server-side scoped wake credential (Cloud-only) — the device vault keeps the token off the control plane entirely.
  - *Known limitations (follow-ups):* a brand-new device gets the token only after an existing device next opens to satisfy its wrapped-key request (the same store-and-forward reality as the node model-auth vault); and **revoke rotation** — re-keying the vault to lock out a removed device — mirrors the room-key rotate path and is not yet wired (a revoked device keeps its last wrapped copy until the vault key is rotated).

Sequencing: **P1 → P2, both done.** P1 unblocks the wake *attempt* with no posture risk (without the token it surfaced a clear "add the token on this device" error instead of hanging); P2 delivers the token so a second device can actually wake + reach the machine.

### Gap B — rebuild-resume for destroy-when-done providers

Resume a torn-down Fly Machine/Hetzner/EC2 session onto a *new* machine. The keystone problem: **there is no node-independent durable store for session state.** Git holds code only; session replication is node→node, off by default, and evaporates if all nodes die. What already exists to build on: the branch push before teardown (`maybePushWorktreeBranch`), and the replication payload shape — `{ git checkpoint bundle, EventLog transcript deltas, runtimeSessionRef }` (`src/session/replication.ts`, `replicator.ts`, `checkpoint-pack.ts`) — plus restore primitives (`applyCheckpointBundle`, `EventLog` rewrite, `writeHistory`, the fork/native-import seeded-summary fallback).

Pieces, in build order (✅ = landed, ◻ = remaining):

1. ✅ **A durable, node-independent snapshot store.** `src/session/snapshot.ts` (`buildSessionSnapshot`/`applySessionSnapshot`) reuses `OwnerReplicator.buildTurnFrame` to produce a full `{records, checkpointCommit, bundle, runtimeSessionRef}` frame, seals it under the node room key (`pairingStore.roomKey()` — the same key that seals `title_enc`), and stores it as an opaque **control-plane blob** in a new session-keyed `session_snapshots` table (`(account_id, session_id)`, mirroring `session_ownership` so it survives the machine's teardown). CP sees only ciphertext. `requireNode` `/node/session-snapshot/:sessionId` GET/PUT/DELETE endpoints. Round-trip unit-tested (`test/session-snapshot.test.ts`, control-plane store test).
2. ✅ **A fail-closed pre-teardown snapshot flush.** `flushSessionSnapshots()` runs inside the daemon's ephemeral self-teardown (`evaluateEphemeralTeardown`) and requires a successful control-plane acknowledgement for every non-empty open session before `performSelfTeardown`. A failed build/upload keeps the runner alive, releases the latch, and retries on the next sweep; the provider TTL remains the final cost backstop.
3. ✅ **Launch-with-existing node/session + restore bootstrap.** `launchEphemeralMachine` gains `reuseNodeId` + `reuseRoomKeyB64` + `restoreSessionId` (LaunchOpts) so a rebuild reuses the torn-down session's node id + room key (the device holds it) and boots with a `BIVY_RESTORE=<sessionId>` export (`bivyBootstrapExports`).
4. ✅ **A boot-time restore orchestrator and startup barrier.** On `BIVY_RESTORE`, the daemon (`restoreSessionFromSnapshot`, `src/server.ts`) GETs the blob, decrypts with the reused room key, and `applySessionSnapshot`—rewriting the EventLog and applying+materializing the git checkpoint via the standby-replica machinery (`ensureReplicaRepo`/`applyCheckpointBundle`/`materializeCheckpoint`)—before unattended queue pollers start. The targeted-session path then resolves the restored metadata into an open session before prompting it. **Runtime fidelity is "reconstructed", not byte-identical**: the transcript replays from the restored EventLog and the runtime starts fresh/seeded (`runtimeSessionRef` names an on-disk store that won't exist on the new box; full native `--resume` via `writeHistory`/`importHistoryForFork` is the documented refinement).
5. ~◻~ **Re-provision entry.** `controller.reprovisionEphemeral(nodeId, sessionId)` re-launches with the restore opts and reconnects. The node-switcher **UI affordance** ("Rebuild"/reopen) is the thin remaining piece — the suspend-resume path (`resumeAndConnectNode`) is itself controller-API-level and not yet UI-wired, so the rebuild trigger lands at the same layer.

Status: **capture + restore are both implemented** end to end at the data-plane + control-plane + daemon + controller layers, verified by typecheck and unit tests (snapshot round-trip, CP store, bootstrap-env). **Needs live end-to-end validation** (a real re-provision on a provider) before GA — the same caveat every ephemeral provider path carries — and two documented refinements: full native runtime resume (vs. seeded), and the node-switcher UI trigger. P2's device-vault key machinery remains the prerequisite for rebuilding on a *different* device; same-device rebuild needs only the reused room key.

**Load-bearing assumption — now wired.** The snapshot is sealed under `pairingStore.roomKey()`, which must equal the `e2eKey` baked into `relay.json` for the reused key to decrypt on the rebuilt machine. Previously nothing seeded it: `loadRelayConfig` ignored `e2eKey` and `PairingStore.load` always minted a fresh random room key, so a rebuild could never decrypt its snapshot. **Fixed:** `loadRelayConfig` parses `e2eKey` (and a `BIVY_ROOM_KEY` override), and `PairingStore.load(appDir, seedRoomKeyB64?)` adopts it when there is no existing `pairing.json` — an already-paired node or a malformed seed always falls back to the existing/fresh key. Covered by `test/pairing-room-key-adoption.test.ts`; still needs live validation on a real re-provision.

**Repo boundary:** the server halves of both gaps (node registry fields, control-plane vault/blob endpoints, the daemon-side sync loop and restore bootstrap) live in the **Cloud repo**; what's implementable here is the `web`/`core` client halves, which must land in lockstep.

### Automatic resume — the message is the trigger (no button)

Resume/wake/rebuild should never need a dedicated button: **sending a message into a dormant session, or a new message arriving on the same issue/thread, is the intent to resume.** Two triggers:

**Case A — interactive send (implemented).** `controller.sendPrompt` intercepts a send into an active session whose node is offline-but-resumable: it shows the bubble, buffers the prompt (`pendingResume`), calls `reprovisionEphemeral` (which self-selects wake for suspend providers vs rebuild for destroy providers), and replays the buffered prompt on reconnect (`drainPendingResume` in `onReconnected`). The composer is unlocked in that state (`isCurrentNodeResumable` → `canCompose` in `App.tsx`) so typing *is* the resume gesture.
- *Covered now:* **suspended Sprites/E2B** — the node stays enrolled (offline) and we hold its room key.
- *Now covered — torn-down destroy-lane.* A durable **session↔machine correlation** (control-plane `session_correlation` table, keyed by session and NOT FK-cascaded off nodes, so it survives unenroll) records the reusable eph-* node id + launch params. The device writes it before teardown and pulls it on reconnect; `isCurrentNodeResumable` now returns true for a torn-down node with a correlation + retained room key (the room key stays in device storage across teardown), and `reprovisionEphemeral` reconstructs the machine from the correlation (`ephemeralMachineFromCorrelation`) when the local record and registry node are both gone. Covered by `test/session-correlation.test.ts` (survives node removal).
- *Reachability during the gap (button-less).* Two things blocked the send-trigger from being *reachable* for a torn-down machine: the session cascaded out of the control-plane index (gone from the sidebar), and `refreshNodes` cleared the gone node (composer locked). Both fixed: `refreshAccountSessions` re-adds a torn-down-but-rebuildable session from the correlation (offline, `SessionSummary.rebuildable`), and `refreshNodes` parks a rebuildable current node offline **without dialing** (`markCurrentNodeAwaitingRebuild` — keeps it selected + the session pane, stops the transport so the header doesn't spin on a gone node) instead of clearing it. So the session stays visible and its composer enabled, and a send fires the rebuild — no "Rebuild" button. Core flag behavior covered by `packages/core/test/rebuildable-session.test.ts`.

**Case B — inbound thread (partially landed).** An inbound issue/comment now CONTINUES an already-indexed session instead of starting fresh: the control plane resolves it via `findSessionByIssue` (matching `session_index.source` `issue:owner/repo#N`) and enqueues the work item with `target={kind:"existing_session"}`; the node types + consumes `targetSessionId`, best-effort restoring the session's snapshot before running when it isn't live here. Live-session continuation already worked via source matching; the remaining piece is deep restore-then-**continue** of a non-live session in the issue runtime (manual-gated).

**Hosted (device-offline) rebuild — landed.** For hosted-provisioning accounts, the control plane escrows the session room key at launch — sealed at rest with the per-account hosted-provisioning key (`hosted-crypto`) in `node_room_keys` (keyed by the reusable node id, surviving teardown) — and `provisionEphemeralRestore` decrypts + injects it into the rebuilt machine (the CP never decrypts the snapshot itself; the machine adopts the key via the fix above and self-restores via `BIVY_RESTORE`). Escrow is hosted-only; device-launched sessions keep the room key device-only. Covered by `test/hosted-room-key-escrow.test.ts`.

**Case B — inbound message on the same issue/thread (scoped, net-new).** A GitHub/Linear/Slack follow-up should continue the *existing* session, rebuilding its machine if gone — with no device online. The mechanisms exist (`WorkItem.target = {kind:"existing_session", sessionId}` in the schema; `launchEphemeralMachine` restore opts; `restoreSessionFromSnapshot`) but the wiring is missing:
1. **Persist the correlation.** The node advertises `githubIssueUrl` per session but the control plane *strips it* (`sessionAdvertsFrom`, `services/control-plane/src/index.ts`). Keep it on `SessionIndexEntry` so the CP can resolve "issue/thread → sessionId + owning nodeId".
2. **Target the existing session on inbound.** In the webhook handlers, look up that index and `enqueueWorkItem({ target: { kind: "existing_session", sessionId } })` (schema already supports it; the node-side `WorkItem` interface in `src/control-plane-tasks.ts` needs `targetKind`/`targetSessionId` added and read by `runWorkItem`).
3. **Consume the target on the node.** `runWorkItem` branches on the target → resume the existing session and run the comment as a turn, instead of always `createSession`.
4. **Restore-mode provision when the machine is gone.** `provisionEphemeralForAccount` forwards `restoreSessionId`/`reuseNodeId`/`reuseRoomKeyB64` to `launchEphemeralMachine` (all supported downstream via `BIVY_RESTORE` → `restoreSessionFromSnapshot`). **The one real blocker:** the control plane holds no room key (`serverLocalStore.keys` is empty), so it can't decrypt the snapshot for a *hosted* rebuild — this is the same credential gap P2's device vault solved for devices, now needed server-side (a scoped, opt-in server-held room/snapshot key, or extending the vault to the control-plane provisioner).

Both the destroy-lane half of Case A and all of Case B hinge on the **durable session→machine/thread correlation** (#1) plus, for hosted rebuilds, the **server-side snapshot key** — those two are the net-new foundation to build next.

## Recommended path

Start with **BYO Fly.io** or **BYO AWS EC2**, whose provider-native process/guest termination deletes the paid resource. Hetzner requires hosted provisioning because powering off its guest does not delete the billable server; the control-plane reconciler must retain deletion authority. These BYO-cloud lanes avoid Bivy owning compute cost while preserving a provider-confirmed cleanup path.

## Comparable providers (survey)

For context on where Fly/Hetzner/AWS sit relative to other options for short-lived, single-VM "run an agent session then destroy" compute:

| Provider | Auth | Provisioning shape | Boot time | Teardown | Cost (small instance) |
|---|---|---|---|---|---|
| Fly Machines | Bearer token | REST/JSON, one `POST .../machines` call | ~0.3–2s | Explicit delete, or auto-destroy config | ~$0.003/hr (shared-1x-256MB) |
| Hetzner Cloud | Bearer token | REST/JSON, one `POST /servers` call | ~10–20s (unofficial) | Explicit delete | ~€0.006/hr (CX22) |
| **AWS EC2** | SigV4-signed (access key + secret) | Query/XML, one `RunInstances` call | user-data starts ~15s in | Explicit terminate, or in-guest self-shutdown | ~$0.01/hr (t3.micro) |
| **Fly Sprites** | Bearer token | REST/JSON, `POST /v1/sprites` + a supervised service | ~1–2s create, instant start/stop | **Suspends to ~$0 when idle** (kept, not destroyed); explicit delete to remove | ~$0.06/hr active, **~$0 suspended** |
| AWS Fargate/ECS | SigV4-signed | JSON, needs a cluster + task definition first, then `RunTask` | 20–60s unoptimized | Task stops on exit, or explicit stop | ~$0.012/hr (0.25vCPU/0.5GB) |
| GCP Compute Engine | Service account (OAuth2) | REST/gRPC, `instances.insert` | not benchmarked | Explicit delete | ~$0.02–0.05/hr (e2-small) |
| DigitalOcean | Bearer token | REST/JSON, `POST /v2/droplets` | not benchmarked | Explicit delete, per-second billing | ~$0.006/hr (smallest droplet) |
| E2B / Modal / Daytona | API key, SDK-first | SDK/thin REST, sandbox-as-a-service | 0.1–5s (sandbox primitives) | Explicit close, or timeout | ~$0.05/vCPU-hr |

AWS EC2 was chosen for the first non-Fly/Hetzner provider because it's the closest match to the existing "create a VM, run cloud-init user-data, destroy it" contract — see the AWS EC2 section above for why EC2 over Fargate/ECS specifically.
