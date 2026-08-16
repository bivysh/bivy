// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Provider-independent workload positioning for ephemeral compute. Providers
// publish facts; this leaf turns them into a small user-facing intent vocabulary.

import type { ProviderSize } from "./ephemeral-provider-ports.js";

export type EphemeralComputeIntent = "quick" | "standard" | "large" | "memory" | "gpu";

export const EPHEMERAL_COMPUTE_INTENT_LABELS: Readonly<Record<EphemeralComputeIntent, string>> = {
  quick: "Quick",
  standard: "Standard",
  large: "Large",
  memory: "Memory optimized",
  gpu: "GPU",
};

/** Classify from declared facts only. Unknown/small plans remain Quick rather
 * than being optimistically presented as suitable for a normal agent workload. */
export function ephemeralComputeIntent(size: ProviderSize): EphemeralComputeIntent {
  if (size.accelerator) return "gpu";
  const memoryMiB = size.memoryMiB ?? 0;
  const vcpus = size.vcpus ?? 0;
  if (memoryMiB >= 64 * 1024) return "memory";
  if (memoryMiB >= 32 * 1024 || vcpus >= 8) return "large";
  if (memoryMiB >= 8 * 1024 && vcpus >= 4) return "standard";
  return "quick";
}

export function ephemeralComputeIntentLabel(size: ProviderSize): string {
  return EPHEMERAL_COMPUTE_INTENT_LABELS[ephemeralComputeIntent(size)];
}
