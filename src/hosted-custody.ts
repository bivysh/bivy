// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// One pure policy decision: does THIS daemon hold only control-plane-custodied
// credentials (the separately escrowed unattended snapshot), or is it a normal
// personal node that owns its vault?
//
// The distinction matters everywhere model-auth sync branches: a custody node
// never pushes/pulls the account vault, never publishes the unattended escrow,
// and treats the control plane's filtered snapshot as an authoritative set
// (reconcile deletes what a newer snapshot omits). Getting this wrong on a
// personal node silently breaks credential sync AND makes the unattended-runs
// toggle a no-op — the "Allowed — encrypted cloud copy enabled" UI then lies,
// and every Bivy Cloud session fails with "credential didn't reach Bivy Cloud".

/**
 * True when this daemon must run with hosted-custody semantics:
 *  - `BIVY_HOSTED_CREDENTIAL_CUSTODY` — the dedicated flag the provisioner sets
 *    on managed (Bivy Cloud) machines; always authoritative.
 *  - `BIVY_GITHUB_HOSTED_TASKS` + `BIVY_EPHEMERAL` — back-compat for
 *    provisioned user-owned queue runners that predate the dedicated flag.
 *
 * `BIVY_GITHUB_HOSTED_TASKS` ALONE is not custody: it is persisted onto any
 * long-lived personal node when a GitHub App is connected (it only means "poll
 * the hosted task queue"). Such a node owns its own logins and must keep full
 * personal-vault semantics — account sync, escrow publishing, loud toggles.
 */
export function hostedCustodyNode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BIVY_HOSTED_CREDENTIAL_CUSTODY) return true;
  return Boolean(env.BIVY_GITHUB_HOSTED_TASKS && env.BIVY_EPHEMERAL);
}
