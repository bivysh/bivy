// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deployment feature flags for the web client.
import { runtimeBoolean } from "./runtime-config.js";

/**
 * Ephemeral machines: bring-your-own-cloud, short-lived runners (Fly.io,
 * Hetzner, AWS EC2). Product access is controlled by provider onboarding and
 * per-account opt-in. Operators enable them on the control-plane container
 * with VITE_EPHEMERAL_MACHINES_ENABLED=1. Its runtime config overrides the
 * build default; standalone/static hosts retain the build-time option.
 *
 * Gates every user-facing entry point: the NodeSwitcher "Ephemeral machine…"
 * menu item, the onboarding "Quick ephemeral server" CTA, the Settings
 * "Ephemeral machines" panel, and the GitHub Queue's ephemeral dispatch/
 * auto-provision options.
 *
 * Mirrors the server-side `EPHEMERAL_MACHINES_ENABLED=0` emergency gate in the
 * control plane (planAutoProvision and the /api/ephemeral/exec relay).
 */
export const EPHEMERAL_MACHINES_ENABLED = runtimeBoolean(
  "ephemeralMachinesEnabled",
  import.meta.env.VITE_EPHEMERAL_MACHINES_ENABLED === "1",
);

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
