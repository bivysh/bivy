<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (c) 2026 Petter André Sjulstad
-->
# Trust model: ephemeral routing & hosted provisioning

Status: hosted provisioning is **off by default, opt-in per account**. This
document describes the trust boundaries for the work-queue routing feature
(ephemeral configs as routable nodes) and, in particular, the **trust-model
change** introduced by control-plane-orchestrated ("hosted") provisioning.

Users don't connect their own cloud accounts. Cloud machines run on compute the
deployment supplies: the deployment extension runs one cloud computer per
account with its own provider credential, which the control plane never sees
(see [self-host.md](self-host.md#deployment-supplied-compute)). The control
plane stores no cloud credential.

It complements `docs/security-model.md`, `docs/ephemeral-sessions.md`, and
`docs/credential-sync.md`; read those for the baseline.

## Principals

| Principal | What it is |
|---|---|
| **Device** | The signed-in browser/CLI. Holds the account session token and the room keys of the sessions it opened. |
| **Control plane (CP)** | The hosted API. Front door for webhooks, enrollment, work-queue metadata, and cloud-machine orchestration. |
| **Relay** | Message bus between CP/devices and nodes. Sees only per-connect tickets and E2E-sealed frames. |
| **Node / machine** | A runner. A *persistent node* is long-lived and holds its own credentials in a local vault; an *ephemeral machine* is a disposable VM the system launches. |
| **Cloud provider** | Fly Machines. Holds the VM; driven by the deployment extension with the deployment's own credential. |
| **GitHub** | Source of webhooks and target of clone/push/PR. Authenticated by a fine-grained PAT or a GitHub App installation token. |

## Baseline invariant (unchanged for everything except hosted provisioning)

> **The control plane holds no repo-capable or cloud-capable credential.**

Concretely, in the pre-existing and device-driven paths:

- **Cloud provider credentials** belong to the deployment, not to users, and
  stay in the deployment extension. The control plane never holds one.
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

> When an account **opts in**, the control plane stores that account's GitHub
> credential (or uses the central GitHub App) and launches and credentials
> machines on the deployment's compute on the account's behalf.

Gating and shape (`HostedProvisioning` in `services/control-plane/src/store.ts`):

- **Off by default**, enabled per account.
- Stored as JSONB on the account row (`hosted_provisioning`).
- Reads are **redacted**: the API never returns token values.
- The machine never holds a cloud credential. The GitHub token is injected as `BIVY_GITHUB_TOKEN`,
  or the machine mints short-lived installation tokens from the control plane.

### What each principal holds — before vs after

| Secret | Baseline (device-driven) | Hosted provisioning (opt-in) |
|---|---|---|
| Cloud provider credential | None (users hold none) | None — the deployment extension holds it and runs the machine |
| GitHub token | Device local storage only | **+ Control plane** (per account) |
| E2E room key | Device-generated, device-held | CP generates the cloud computer's key once and **escrows it at rest** (`node_room_keys`, sealed with the per-account hosted key) so it can boot the machine with no device online — injected into its boot payload, never used to decrypt a snapshot CP-side |
| Model credentials | Peer-wrapped account vault (CP-blind) | **Per-item opt-in.** Bivy creates a separate filtered ciphertext containing only credentials marked “Allow unattended runs”, encrypts it under a different key, and seals that key at rest in `hosted_model_auth_keys`. Escrowing the hosted key cannot decrypt the ordinary account vault. Non-hosted accounts stay fully peer-wrapped. |
| Node enrollment token | Device | CP re-enrolls the cloud computer's node on each boot and puts the fresh token in its boot payload |
| GitHub App private key | Node vault only | Unchanged (not used by this path) |

## Data flow: hosted provisioning

```
GitHub webhook ─▶ CP enqueue ─▶ notifyRelaysWorkAvailable
                                      │  (every enqueue funnels here)
                                      ▼
                          routeWorkToCloudComputer(account)
                          routing→cloud? (primary, or fallback while
                          the chosen machine is offline)
                                      │  yes: work moves to the cloud
                                      ▼  computer's label
                   deployment extension /v1/compute/acquire
                                      ▼
                   deployment starts the account's machine and calls
                   /internal/compute/bootstrap:
                     • enroll bearer    ← CP re-enrolls the stable node
                     • room key         ← CP escrow
                     • GitHub identity  ← mint-on-demand, or CP hosted vault
                                      ▼
                   the cloud computer boots, claims the work item, does
                   clone/push/PR, then sleeps when quiet.
```

Routing logic (`routeWorkToCloudComputer` in
`services/control-plane/src/cloud-computer.ts`): the cloud computer is needed
when routing points at the deployment's cloud profile as a `config` primary, or
as a `node` primary's fallback while that node is offline. A `config` primary is
the designated runner; a `node` primary only falls back when it is offline.

## Threat model (compromise scenarios)

| If compromised… | Baseline exposure | Hosted-provisioning exposure |
|---|---|---|
| **Control plane** | Webhook secrets, work-queue metadata, ciphertext. **No** repo/cloud creds. | **+ GitHub credentials of opted-in accounts and the escrowed cloud computer room keys** — the single highest-value target. Attacker can ask the deployment extension for machines and act on opted-in accounts' repos. |
| **Relay** | Tickets + sealed frames only. | Unchanged. |
| **Ephemeral machine** | The injected `BIVY_GITHUB_TOKEN` (scoped, and short-lived if an app installation token) + its enrollment token. Disposable. | Same. Never holds the cloud provider credential or the app private key. |
| **Device** | All of that device's launch secrets. | Same (a device may still hold its own copies). |
| **Provider credential leak** | — | The deployment's cloud account. |

The net change is concentrated in one place: **compromise of the control plane
now exposes the GitHub credentials of accounts that opted into hosted
provisioning, and the escrowed room keys of their cloud computers.** Everything else is unchanged. This is why the feature is opt-in
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
   **writes fail closed** (503) when no key is configured. Keys come through a
   pluggable source: environment keys by default, or encrypted data-key blobs
   decrypted by AWS KMS at boot. Callers do not depend on the selected source.
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
4. **One machine per account** — Core never launches machines. The deployment
   extension runs at most one cloud computer per account, owns its lifecycle
   and enforces any limits when Core asks to acquire it.

## The central GitHub App (managed tier)

Beyond BYO credentials, the operator can register ONE **central GitHub App**
(`BIVY_CENTRAL_GITHUB_APP_ID` + `BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY`, plus a
webhook secret and slug). Users then just install that app on their org/user
and pick repos — no app creation, no PAT. Absent config, the feature is
cleanly off; self-hosters can register their own "central" app.

**Trust delta.** The central app's private key lives in operator env config on
the control plane, so the CP can mint a ~1 h installation token for **any repo
the app is installed on**. This concentrates GitHub reach for every opted-in
account into one key — a strictly wider version of the per-account
hosted-credential exception above. Bounds on that power:

- **JIT, scoped, never stored.** Tokens are minted on demand per git operation
  (`POST /node/hosted-git-credential`), scoped down to the session repo where
  the GitHub API allows, and never persisted. Users choose which repos the
  installation covers on GitHub's own consent screen.
- **Identity mode is explicit data.** Per account,
  `githubIdentity: "central-app" | "own-app" | "token"` selects the credential
  source through one resolution table (`central-github-app.ts`); unset keeps
  the pre-central behavior (own app, then PAT) with the central app only as a
  final fallback. BYO paths are unchanged.
- **Account binding requires proof.** An installation is bound to an account
  only via the state-signed setup callback (single-use, 15 min, minted by the
  signed-in account) — never by an installation id alone, which is enumerable.
  The id is additionally verified to belong to the central app via an app-JWT
  lookup, and an id already bound to another account is refused. `installation`
  webhooks update/remove only already-bound installations.
- **Isolation.** Minting resolves only installations bound to the requesting
  node's account; account A can never mint against B's installation (unit- and
  e2e-tested).
- **Audited.** Binds, unbinds, and every mint append to the same per-account
  `hosted-audit` trail.

If the control plane is compromised, the central app key must be treated as
compromised: revoke it in the GitHub App settings (one place), which
invalidates all installations at once. This is deliberately more recoverable
than mass-leaked PATs.

### Still recommended before GA
- Extend the keyring beyond the current env and **AWS KMS** sources (for example,
  an HSM) without changing callers.
- **Scope** the GitHub App installation to the minimum repos / permissions
  needed (operational).
- **Verify the installer's identity** in the central-app setup callback via
  GitHub user OAuth (`code` exchange → `GET /user/installations`). The state
  nonce already proves which Bivy account initiated the install; OAuth would
  additionally prove the GitHub user completing it has access to that
  installation, closing the residual race where an attacker holding a fresh
  state binds a victim's just-created, not-yet-bound installation.

## Design principles preserved

- Hosted provisioning is **opt-in and reversible**; disabling it stops all
  server-side launches and the credentials can be cleared.
- The **machine never holds a cloud credential**; the deployment's provider
  credential is used only transiently by the control plane.
- Every other trust boundary (relay blindness, E2E vaults, node-held app keys)
  is **unchanged**. The exception is
  narrow, named, and gated — not a general relaxation of "the control plane holds
  no secrets."
