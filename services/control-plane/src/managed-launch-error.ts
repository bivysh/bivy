// SPDX-License-Identifier: AGPL-3.0-only
/** Return only allowlisted diagnostics, never provider bodies/bootstrap secrets. */
export function publicManagedLaunchError(error: unknown): { code: string; error: string } {
  const message = error instanceof Error ? error.message : "";
  if (/failed to get manifest|MANIFEST_UNKNOWN|manifest unknown/i.test(message)) {
    return { code: "managed_image_unavailable", error: "The configured runner image is unavailable. The deployment needs repair; retry this same launch after it is fixed." };
  }
  return { code: "managed_launch_failed", error: "Managed launch failed. Retry the same request to recover it." };
}
