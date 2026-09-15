// SPDX-License-Identifier: AGPL-3.0-only
/** Runtime values override build defaults; malformed explicit values fail closed. */
export function runtimeBoolean(
  name: string,
  fallback: boolean,
  config: unknown = (globalThis as { __BIVY_RUNTIME_CONFIG__?: unknown }).__BIVY_RUNTIME_CONFIG__,
): boolean {
  if (!config || typeof config !== "object" || !(name in config)) return fallback;
  return (config as Record<string, unknown>)[name] === true;
}
