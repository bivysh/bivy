// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Build-time feature flags for the web client.
//
// These gate not-yet-shipped surfaces so their code can stay in the tree,
// compiled and reviewable, without being reachable by users. Flip a flag to
// `true` to bring the feature back online — no other wiring needed.

/**
 * Ephemeral machines: bring-your-own-cloud, short-lived runners (Fly.io,
 * Hetzner, AWS EC2). This is currently a visible Beta surface. Keep this comment
 * and the flag aligned: changing exposure is a release decision, not dead-code
 * documentation.
 *
 * Gates every user-facing entry point: the NodeSwitcher "Ephemeral machine…"
 * menu item, the onboarding "Quick ephemeral server" CTA, the Settings
 * "Ephemeral machines" panel, and the GitHub Queue's ephemeral dispatch/
 * auto-provision options.
 */
export const EPHEMERAL_MACHINES_ENABLED = true;

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
