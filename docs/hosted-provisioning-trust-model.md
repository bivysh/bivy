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
| E2E room key | Device-generated, device-held | CP generates it and **escrows it at rest** (`node_room_keys`, sealed with the per-account hosted key) so it can rebuild a torn-down session with no device online — injected into the new machine, never used to decrypt a snapshot CP-side |
| Model-auth vault key | Peer-wrapped only (CP-blind) | **Escrowed at rest** (`hosted_model_auth_keys`, sealed with the per-account hosted key) so a LONE hosted ephemeral inherits the account's model credentials (incl. subscription OAuth) with no peer to wrap the key — enables "sign in once from the app, every hosted ephemeral inherits it." Non-hosted accounts stay fully peer-wrapped. |
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

## Hardening — implemented

The following are implemented (see the modules noted); items marked *interim*
have a clear production upgrade path.

1. **Encryption at rest, per-account isolation, key rotation** — every hosted
   secret is sealed with AES-256-GCM under a per-account subkey derived via
   HKDF-SHA256 from a keyring master key (`hosted-crypto.ts`). Each envelope
   records its key id (`kid`), so a new primary key can be introduced while old
   ciphertext still decrypts; rotation (`POST /account/hosted-provisioning/rotate`)
   re-seals under the primary. Ciphertext is bound to its account (a cross-account
   decrypt fails); no plaintext credential is ever written to the database, and
   **writes fail closed** (503) when no key is configured. *Interim:* keys come
   from `HOSTED_CREDENTIAL_KEYS`/`HOSTED_CREDENTIAL_KEY`; swap `loadKeyring()` for
   a KMS/HSM to upgrade without touching callers.
2. **Audit trail** — every credential update, provision attempt/launch/failure,
   token mint, and machine reap is recorded per account (`appendHostedAudit`),
   readable at `GET /account/hosted-audit`. Events never contain secrets.
3. **Short-lived minted credentials — no static token on the machine** — with a
   hosted **GitHub App**, the machine carries *no* GitHub token: it self-mints a
   fresh ~1 h installation token from the control plane per git op via
   `BIVY_HOSTED_MINT` → `POST /node/hosted-git-credential` (node-authenticated),
   resolved as the final fallback in the node's git-credential path
   (`hostedMintToken` in `src/server.ts`) and cached until ~5 min before expiry.
   Sessions of any length work without a long-lived secret ever landing on the
   machine. A stored PAT remains the legacy fallback when no app is configured.
   (`hosted-github-auth.ts`.)
4. **Rate cap** — provisions per account per hour are bounded
   (`HOSTED_PROVISION_MAX_PER_HOUR`, default 5) in the provisioning decision, on
   top of the one-at-a-time dedupe window.
5. **Server-side lifecycle reconciliation** — the CP tracks the machines it
   launched and reaps them past TTL (`reconcileHostedMachines`): it drops the
   tracking record and unenrolls the node (freeing the node-limit slot). The VM
   self-destructs at its TTL independently; this keeps CP state accurate without
   relying on a device.

### Still recommended before GA
- Back the keyring with a real **KMS/HSM** — rotation and per-key-id envelopes
  are already in place, so only the key *source* (`loadKeyring()`) needs swapping.
- **Scope** the GitHub App installation and cloud tokens to the minimum repos /
  permissions needed (operational).
- Exercise a real **end-to-end cloud launch** with live provider credentials
  (the code path is complete; it needs a real provider account to run).

## Design principles preserved

- Hosted provisioning is **opt-in and reversible**; disabling it stops all
  server-side launches and the credentials can be cleared.
- The **machine never holds a long-lived cloud credential**; provider tokens are
  used only transiently at launch.
- Every other trust boundary (relay blindness, E2E vaults, node-held app keys,
  device-local secrets for the device path) is **unchanged**. The exception is
  narrow, named, and gated — not a general relaxation of "the control plane holds
  no secrets."
