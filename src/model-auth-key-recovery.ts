// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Validate keys against the vault before caching them or sharing them with peers.
 * A stale local key must not hide a fresh peer wrap; an unusable wrap must never
 * be persisted as though key recovery succeeded. No credential data is changed.
 */
export function recoverModelAuthKey<T>(options: {
  localKey?: string;
  unwrap?: () => string;
  decrypt(key: string): T;
}): { key: string; value: T } | undefined {
  if (options.localKey) {
    try { return { key: options.localKey, value: options.decrypt(options.localKey) }; }
    catch { /* Try the peer's replacement before requesting another wrap. */ }
  }
  if (options.unwrap) {
    try {
      const key = options.unwrap();
      return { key, value: options.decrypt(key) };
    } catch { /* The caller must reject this exact wrap and request a new one. */ }
  }
  return undefined;
}
