<!--
SPDX-License-Identifier: FSL-1.1-ALv2
Copyright (c) 2026 Petter André Sjulstad
-->
# Trust model: ephemeral routing & hosted provisioning

Status: hosted provisioning is **off by default, opt-in per account**. This
document describes the trust boundaries for the work-queue routing feature
(ephemeral configs as routable nodes) and, in particular, the **trust-model
change** introduced by control-plane-orchestrated ("hosted") provisioning.

It complements `docs/security-model.md`, `docs/ephemeral-sessions.md`, and
`docs/credential-sync.md`; read those for the baseline.

## Principals

| Principal | What it is |
|---|---|
| **Device** | The signed-in browser/CLI. Holds the account session token and, historically, all launch secrets (cloud provider tokens, GitHub token) in local storage. |
| **Control plane (CP)** | The hosted API. Front door for webhooks, enrollment, billing, work-queue metadata, and the ephemeral-exec relay. |
| **Relay** | Message bus between CP/devices and nodes. Sees only per-connect tickets and E2E-sealed frames. |
| **Node / machine** | A runner. A *persistent node* is long-lived and holds its own credentials in a local vault; an *ephemeral machine* is a disposable VM the system launches. |
| **Cloud provider** | Fly/Hetzner/AWS. Holds the VM; authenticated by a provider token. |
| **GitHub** | Source of webhooks and target of clone/push/PR. Authenticated by a fine-grained PAT or a GitHub App installation token. |

## Baseline invariant (unchanged for everything except hosted provisioning)

> **The control plane holds no repo-capable or cloud-capable credential.**

Concretely, in the pre-existing and device-driven paths:

- **Cloud provider tokens** live in the device's local storage
  (`provider-keys` IndexedDB) and are **never sent to the CP**. When a device
  launches a machine, provider API calls are forwarded through the CP's
  `/api/ephemeral/exec` relay, which is a **stateless, allowlisted, non-storing**
  forwarder — the token rides in the request and is never persisted or logged.
- **GitHub credentials**: a device-held fine-grained PAT
  (`BIVY_GITHUB_TOKEN`), injected into a machine at launch via provider
  user-data; or, on a persistent node, a GitHub **App private key** that stays
  in the node's own vault (`secret://github.app.<id>`), from which the node
  mints its own ~1 h installation tokens. The CP only ever holds the app's
  webhook secret, never a repo-capable credential.
- **E2E**: a per-node room key is generated on the device and used to seal
  traffic; the CP and relay see ciphertext only. Secrets delivered post-boot
  (model keys, synced app keys) travel as ECDH-wrapped vault envelopes the CP
  cannot decrypt.
- The **relay** authenticates nodes with short-lived, single-use tickets minted
  from the enrollment token; it never sees a reusable credential.

The routing feature added in this change (account-level `EphemeralNodeConfig`
and `QueueRouting`) stores **non-secret** data only (a config names a provider
and sizing; routing names a runner). It does **not** alter the baseline.

## The trust-model change: hosted provisioning

Truly unattended provisioning — the CP launches an ephemeral machine when a
webhook arrives with **no device online** — is impossible under the baseline
invariant. If the CP is the only always-on party that must both *launch a VM*
and *give it a repo credential*, it cannot also be blind to those credentials.
This is an information-theoretic wall, not an implementation gap.

Hosted provisioning therefore makes a **deliberate, scoped exception**:

> When an account **opts in**, the control plane stores that account's cloud
> provider token(s) and a GitHub token, and uses them to launch and credential
> ephemeral machines on the account's behalf.

Gating and shape (`HostedProvisioning` in `services/control-plane/src/store.ts`):

- **Off by default**, enabled per account.
- Stored as JSONB on the account row (`hosted_provisioning`).
- Reads are **redacted**: the API never returns token values, only
  `{ enabled, hasGithubToken, providers[] }`.
- The machine still never holds a *long-lived* cloud credential: the provider
  token is used transiently at launch. The GitHub token is injected as
  `BIVY_GITHUB_TOKEN` (same as the device path).

### What each principal holds — before vs after

| Secret | Baseline (device-driven) | Hosted provisioning (opt-in) |
|---|---|---|
| Cloud provider token | Device local storage only | **+ Control plane** (per account) |
| GitHub token | Device local storage only | **+ Control plane** (per account) |
| E2E room key | Device-generated, device-held | CP generates & holds it for machines it launches |
| Account session token | Device | CP mints one per launch (`createSession`) to self-enroll |
| GitHub App private key | Node vault only | Unchanged (not used by this path) |

## Data flow: hosted provisioning

```
GitHub webhook ─▶ CP enqueue ─▶ notifyRelaysWorkAvailable
                                      │  (every enqueue funnels here)
                                      ▼
                          maybeAutoProvision(account)
                          gate: enabled? routing→config? creds?
                                no node online? not already provisioning?
                                      │  yes
                                      ▼
                   launchEphemeralMachine (server-side deps):
                     • provider token  ← CP hosted vault
                     • enroll bearer    ← CP createSession(account)
                     • provider API     ← direct fetch (host-allowlisted)
                     • BIVY_GITHUB_TOKEN← CP hosted vault
                                      ▼
                   ephemeral VM boots, claims the work item, does
                   clone/push/PR with the injected GitHub token, then
                   self-destructs at TTL.
```

Decision logic (`planAutoProvision`): provision only when hosted provisioning is
enabled **and** routing points at an ephemeral config (as a `config` primary, or
as a `node` primary's fallback while that node is offline) **and** a provider
token exists for the config's provider **and** no persistent node is online
**and** no recent hosted machine is already active (dedupe window). A `config`
primary is the designated runner; a `node` primary only falls back to its config
when nothing is online.

## Threat model (compromise scenarios)

| If compromised… | Baseline exposure | Hosted-provisioning exposure |
|---|---|---|
| **Control plane** | Webhook secrets, work-queue metadata, ciphertext. **No** repo/cloud creds. | **+ cloud provider tokens and GitHub tokens of opted-in accounts** — the single highest-value target. Attacker can launch VMs on the account's cloud and act on its repos. |
| **Relay** | Tickets + sealed frames only. | Unchanged. |
| **Ephemeral machine** | The injected `BIVY_GITHUB_TOKEN` (scoped, and short-lived if an app installation token) + its enrollment token. Disposable. | Same. Never holds the cloud provider token or the app private key. |
| **Device** | All of that device's launch secrets. | Same (a device may still hold its own copies). |
| **Provider token leak** | Cloud account for that provider. | Same, but now also reachable via the CP. |

The net change is concentrated in one place: **compromise of the control plane
now exposes the cloud/GitHub credentials of accounts that opted into hosted
provisioning.** Everything else is unchanged. This is why the feature is opt-in
and why the hardening below is mandatory for production.

## Required hardening (production)

The current implementation is a functional first cut. Before hosted provisioning
is exposed to real accounts:

1. **Encrypt credentials at rest with a KMS/HSM**, per-account key isolation —
   never plaintext JSONB. Store as a `secret://`/KMS reference, not inline.
2. **Audit every use** (which account, provider, repo, work item, when).
3. **Prefer short-lived, minted credentials over stored long-lived ones.** A
   GitHub App installation token (~1 h, repo-scoped, minted on demand) is
   strictly better than a stored PAT; a mint-on-demand endpoint keeps sessions
   of any length working without a static secret on the machine.
4. **Scope tightly**: the GitHub token should be a fine-grained PAT / app
   installation limited to the intended repos; cloud tokens scoped to the
   minimum the launcher needs.
5. **Rate-limit and cap** auto-provisions per account (cost + runaway
   protection); `log()` anything dropped.
6. **Reconcile machine lifecycle server-side**: TTL is the safety net, but the
   CP should track and tear down the machines it launched rather than relying on
   a device.

## Design principles preserved

- Hosted provisioning is **opt-in and reversible**; disabling it stops all
  server-side launches and the credentials can be cleared.
- The **machine never holds a long-lived cloud credential**; provider tokens are
  used only transiently at launch.
- Every other trust boundary (relay blindness, E2E vaults, node-held app keys,
  device-local secrets for the device path) is **unchanged**. The exception is
  narrow, named, and gated — not a general relaxation of "the control plane holds
  no secrets."
