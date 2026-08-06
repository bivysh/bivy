// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Build-time feature flags for the web client.
//
// These gate not-yet-shipped surfaces so their code can stay in the tree,
// compiled and reviewable, without being reachable by users. Flip a flag to
// `true` to bring the feature back online — no other wiring needed.

/**
 * Ephemeral machines: bring-your-own-cloud, short-lived runners (Fly.io,
 * Hetzner, AWS EC2). A Beta surface, OFF by default (fail-closed): a built
 * bundle only exposes it when `VITE_EPHEMERAL_MACHINES_ENABLED=1` is baked in at
 * build time. Local `vite dev` (import.meta.env.DEV) keeps it on so day-to-day
 * development isn't gated. Every real deploy is a production build, so it's off
 * unless that deploy opts in — staging bakes the flag, production omits it.
 *
 * Gates every user-facing entry point: the NodeSwitcher "Ephemeral machine…"
 * menu item, the onboarding "Quick ephemeral server" CTA, the Settings
 * "Ephemeral machines" panel, and the GitHub Queue's ephemeral dispatch/
 * auto-provision options.
 *
 * Mirrors the server-side `EPHEMERAL_MACHINES_ENABLED` gate in the control plane
 * (ephemeral-provisioner planAutoProvision and the /api/ephemeral/exec relay) —
 * enable both to fully bring the feature online in a given deploy.
 */
export const EPHEMERAL_MACHINES_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_EPHEMERAL_MACHINES_ENABLED === "1";

/**
 * DEBUG: keep a boot-failed ephemeral machine alive instead of letting it
 * self-destruct, so its boot logs survive for inspection (Fly `auto_destroy` is
 * disabled at provision when set). A failed boot otherwise vanishes the machine
 * and its logs, which is why "it never starts" is currently undebuggable.
 *
 * Trade-off while on: a machine that boots fine also won't self-reap on exit, so
 * it lingers until torn down manually. It is OFF by default and requires an
 * explicit staging/debug build setting; production must never retain billable
 * machines merely to preserve logs.
 */
export const EPHEMERAL_KEEP_FAILED_MACHINES = import.meta.env.VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1";
