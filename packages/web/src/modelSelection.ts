// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** ACP catalogs are conservative before the session handshake. A configured
 * model list for this exact runtime is stronger evidence than that static flag.
 * Never borrow another runtime's list, or unconnected provider suggestions.
 */
export function modelSelectionAvailable(
  runtimeId: string | null | undefined,
  advertised: boolean | undefined,
  modelsRuntimeId: string | null | undefined,
  models: ReadonlyArray<{ id: string; configured?: boolean }>,
): boolean {
  return advertised !== false || Boolean(
    runtimeId && modelsRuntimeId === runtimeId && models.some(model => model.configured !== false),
  );
}
