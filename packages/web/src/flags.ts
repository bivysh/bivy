// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deployment feature flags for the web client.
import { runtimeBoolean } from "./runtime-config.js";

// Vite defines import.meta.env; outside a Vite build (node tests) it is absent.
const env: Record<string, string | undefined> = import.meta.env ?? {};

/**
 * Deployment-provided cloud machines ("Bivy Cloud"): shown in the machine
 * picker, fork/move, and automation routing when the deployment supplies
 * compute. Operators enable them on the control-plane container with
 * EPHEMERAL_MACHINES_ENABLED=1; its runtime config overrides the build
 * default. Mirrors the server-side emergency gate, which stops new launches but
 * never cleanup.
 */
export const EPHEMERAL_MACHINES_ENABLED = runtimeBoolean(
  "ephemeralMachinesEnabled",
  env.EPHEMERAL_MACHINES_ENABLED === "1",
);
