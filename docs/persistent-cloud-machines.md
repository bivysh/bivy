<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (c) 2026 Petter André Sjulstad
-->
# Persistent machines: BYO first, managed hosting second

## Product direction

Bivy should be excellent on machines users own. Offer two paths:

1. Connect an existing Mac/Linux machine or let Bivy provision a persistent
   server in the user's cloud account. The user pays their provider directly.
2. Eventually offer a paid, always-on managed Hetzner machine for users who do
   not want to operate a server. This is an operations product, not an artificial
   restriction on the open-source software.

Use 8 GB RAM and roughly 4 x86 vCPUs as the initial recommended development
baseline. Allow 4 GB as an explicit budget choice for lighter/tuned workloads.
Neither size guarantees a particular number of concurrent builds or agents.
Use the provider's available sizes rather than promising a fixed SKU or price.

Sleeping Hetzner servers remain billable; do not describe power-off as a cost
saving. GPU/local-model hosting is not part of the initial offer.

## Implemented first slice

- Existing one-time install/enrollment instructions remain the primary way to
  connect an existing machine.
- First-run connection and **Add a Machine** offer **Create your own server**
  when the deployment enables provisioning (`EPHEMERAL_MACHINES_ENABLED=1`).
  The existing provider HTTP relay still enforces deployment admission. This
  BYO path does not require the local opt-in for disposable machine profiles.
- Hetzner is the first supported persistent provider. Setup validates and saves
  a project token without creating a disposable session profile, offers region
  and x86 size selection, and requires explicit confirmation before purchase.
- Approximate monthly compute is hourly price × 730, not a quote. Provider
  caps, IPs, taxes, traffic and backups may change the bill. The existing size
  service can fall back to indicative catalog entries when live lookup fails;
  final availability is decided by the provider.
- `lifecycle: "persistent"` is independent of `computeSource`. Missing lifecycle
  retains legacy ephemeral behavior. A provider capability explicitly permits
  persistent provisioning; only Hetzner currently advertises it.
- Persistent bootstrap has no TTL shutdown timer or daemon self-teardown flags.
  An enabled, on-disk systemd unit restarts Bivy after reboot or daemon exit.
- Persistent nodes use `server-…`, not `eph-…`, and therefore appear in the
  ordinary account machine list. Subsequent sessions reuse that node.
- Persistent machine records cannot trigger session-finish deletion or ephemeral
  restore/reprovision. They do not publish disposable session correlations.
- No provider credential is installed in the guest. Provider credentials use
  the existing encrypted device vault, while requests pass through the Bivy
  provider API relay. This is not a claim that the relay cannot see request
  credentials. Revocation after setup does not stop ordinary node operation.
- Disconnecting an account node explicitly warns that it neither deletes the
  provider resource nor stops its charges. Initial management/deletion is via
  the provider console.

### Deliberate boundaries

This is **device-provisioned BYO only**. Persistent launches reject managed
credentials, hosted teardown authority, and hosted ownership tags. Hosted
reconciliation remains TTL-based and must not own these machines yet.

Existing ephemeral launches retain their current defaults, safety checks,
provider teardown and billing protections. Existing machines are not migrated.
In particular, ephemeral Hetzner still requires hosted deletion authority.

The purchase UI prevents repeated creation while an attempt is in progress and
never automatically retries an ambiguous provider create. If creation fails,
it directs users to inspect the provider console first: a response timeout can
leave a paid server behind. Keep the setup page open through creation. Durable
cross-device recovery of interrupted BYO provisioning is not implemented in
this slice; restarting setup is not an idempotent retry of the prior attempt.
Connection retries reuse the created node and never create another VM.

BYO is not managed hosting: users own OS/security updates, firewall policy,
provider quotas, backups and recovery. Bootstrap currently runs Bivy as root,
like the existing VM bootstrap, and does not add a provider-side firewall or
managed backups. Do not advertise this image as a hardened multi-tenant managed
service baseline. A persistent system disk is not a disaster-recovery guarantee.

## Remaining work before paid managed hosting

- Obtain provider approval and enough CPU/IP quota, including recovery headroom.
- Define the subscription price from actual compute, disk, IP, backup, network,
  payment and operational costs. Model-provider charges remain separate.
- Add an account-owned machine and storage identity, with idempotent
  ensure/reuse semantics, desired/observed state, and bounded provisioning.
- Make **every** hosted reconciler, orphan sweep, settlement callback and billing
  calculation lifecycle-aware before allowing persistent managed launches.
- Add provider-observed ongoing accounting, payment suspension, grace periods,
  retention/export and explicit deletion. Do not rely on guest reports for
  commercial enforcement.
- Validate tenant/network isolation, infrastructure/metadata protections,
  external resource/abuse controls, unprivileged agent execution, and an honest
  staff-access/privacy policy. Root in the guest cannot disable critical
  platform controls.
- Implement backups outside guest control and test full-environment restores,
  including installed system packages. Define recovery-point/time targets and
  document crash-consistency limitations for arbitrary databases.
- Define update ownership, restart windows and recovery for modified systems.
- Pilot one supported 8 GB size and limited regions. Keep the managed offer
  gated until billing, security, capacity and restoration have been validated.

## Verification

Automated coverage includes legacy TTL compatibility, persistent bootstrap and
machine identity, unsupported/hosted launch rejection before effects, no
session-finish teardown or replacement, and desktop/mobile light/dark setup,
billing confirmation, credential errors, empty sizes, create failure and
connection retry. Provider calls are mocked; these tests purchase nothing.

Before enabling for a pilot, use an explicitly authorized test Hetzner project:

1. Confirm creation requires consent and creates exactly one server.
2. Confirm the configured disk, architecture and live price in the console.
3. Wait for enrollment, start two sessions, and confirm both use the same VM.
4. Install a tool and save a file; finish sessions, close the browser, and leave
   the machine idle beyond the old TTL. Confirm no teardown occurs.
5. Reboot through the provider console. Confirm `bivy.service` starts, the same
   account node reconnects, and the installed tool/file remain.
6. Revoke the provisioning token and confirm normal Bivy operation continues.
7. Verify firewall exposure and update/backup responsibilities before real work.
8. Delete the test server explicitly, confirm provider deletion and any separate
   billable resources, then remove its Bivy enrollment.

No live paid provisioning or reboot test was performed during this implementation.
