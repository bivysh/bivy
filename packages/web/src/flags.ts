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
 * Hetzner, AWS EC2). Hidden for now while the feature is built out — the
 * underlying core adapters, node proxy, and controller bridge stay intact.
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
 * it lingers until torn down manually — acceptable for staging diagnosis only.
 * Turn OFF before shipping to users.
 */
export const EPHEMERAL_KEEP_FAILED_MACHINES = true;
