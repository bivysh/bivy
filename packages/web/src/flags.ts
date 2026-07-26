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
