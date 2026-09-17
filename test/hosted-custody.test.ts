// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The hosted-custody policy decision (src/hosted-custody.ts). Regression for
// the staging outage where a persistent personal node with a connected GitHub
// App (BIVY_GITHUB_HOSTED_TASKS is persisted by github-app-connect) was
// silently demoted to managed-guest custody: it stopped publishing the
// unattended escrow, so the "encrypted cloud copy enabled" toggle no-op'd and
// every Bivy Cloud session failed with "credential didn't reach Bivy Cloud".

import assert from "node:assert/strict";

import { hostedCustodyNode } from "../src/hosted-custody.js";

// A plain personal node is never a custody guest.
assert.equal(hostedCustodyNode({}), false);

// The dedicated flag (managed Bivy Cloud machines) is always authoritative.
assert.equal(hostedCustodyNode({ BIVY_HOSTED_CREDENTIAL_CUSTODY: "1" }), true);
assert.equal(hostedCustodyNode({ BIVY_HOSTED_CREDENTIAL_CUSTODY: "1", BIVY_EPHEMERAL: "1" }), true);

// A PERSISTENT node that polls the hosted GitHub queue keeps personal-vault
// semantics — connecting a GitHub App must not break credential sync/escrow.
assert.equal(hostedCustodyNode({ BIVY_GITHUB_HOSTED_TASKS: "1" }), false);
assert.equal(hostedCustodyNode({ BIVY_GITHUB_HOSTED_TASKS: "1", BIVY_GITHUB_APP_SLUG: "bivy-staging" }), false);

// Back-compat: a provisioned (ephemeral) queue runner without the dedicated
// flag still runs with custody semantics.
assert.equal(hostedCustodyNode({ BIVY_GITHUB_HOSTED_TASKS: "1", BIVY_EPHEMERAL: "1" }), true);

// An ephemeral machine without hosted-tasks or the dedicated flag (e.g. a
// user-owned interactive launch fed by peer key-wrapping) is not custody.
assert.equal(hostedCustodyNode({ BIVY_EPHEMERAL: "1" }), false);

console.log("hosted-custody: all tests passed");
