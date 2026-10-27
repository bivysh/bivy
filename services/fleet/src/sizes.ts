// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Machine sizes a fleet can run. A new size is a row, not a branch.
//
// `weight` is how fast an awake hour at this size uses an account's allowance,
// in Standard hours. It follows the provider's list price relative to Standard
// (4 shared vCPU / 8 GB): 8 shared vCPU / 16 GB is 2x, 4 dedicated / 8 GB is
// ~5.3x. Rounded up, so a bigger hour is never metered below its cost.

/** Hardware tiers a deployment can allow separately. */
export type SizeClass = "standard" | "boost" | "performance";

export interface MachineSize {
  label: string;
  class: SizeClass;
  cpuKind: "shared" | "performance";
  vcpus: number;
  memoryMiB: number;
  weight: number;
  /** Offered for a cloud computer; the other rows only describe sizes a
   * machine may already be running. */
  offered: boolean;
}

export const SIZES: Record<string, MachineSize> = {
  "shared-2x-4gb": { label: "Small", class: "standard", cpuKind: "shared", vcpus: 2, memoryMiB: 4096, weight: 1, offered: false },
  "shared-4x-8gb": { label: "Standard", class: "standard", cpuKind: "shared", vcpus: 4, memoryMiB: 8192, weight: 1, offered: true },
  "shared-8x-16gb": { label: "Boost", class: "boost", cpuKind: "shared", vcpus: 8, memoryMiB: 16384, weight: 2, offered: true },
  "performance-2x-4gb": { label: "Performance 2x", class: "performance", cpuKind: "performance", vcpus: 2, memoryMiB: 4096, weight: 3, offered: false },
  "performance-4x-8gb": { label: "Performance", class: "performance", cpuKind: "performance", vcpus: 4, memoryMiB: 8192, weight: 6, offered: true },
};

/** Weight of a size; unknown sizes meter as Standard. */
export function sizeWeight(size: string): number {
  return SIZES[size]?.weight ?? 1;
}
