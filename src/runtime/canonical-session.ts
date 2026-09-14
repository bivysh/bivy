// SPDX-License-Identifier: AGPL-3.0-only
import type { RuntimeSession } from "./types.js";

/** Keep Bivy's durable identity when a portable import receives a new native id.
 * Methods/accessors still run against the native object (including private
 * fields and provider resume ids). No per-agent identity rewriting is needed. */
export function canonicalSession(session: RuntimeSession, id?: string): RuntimeSession {
  if (!id || session.id === id) return session;
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  // A facade target also supports frozen native session objects: a Proxy over
  // the native object cannot override a non-configurable, read-only id.
  return new Proxy(Object.create(Object.getPrototypeOf(session)) as RuntimeSession, {
    get(_target, key) {
      if (key === "id") return id;
      const value = Reflect.get(session, key, session);
      if (typeof value !== "function") return value;
      if (methods.get(key)?.original !== value) methods.set(key, { original: value, bound: value.bind(session) });
      return methods.get(key)!.bound;
    },
    set: (_target, key, value) => key !== "id" && Reflect.set(session, key, value, session),
    has: (_target, key) => key === "id" || key in session,
    ownKeys: () => [...new Set([...Reflect.ownKeys(session), "id"])],
    getOwnPropertyDescriptor(_target, key) {
      if (key === "id") return { value: id, enumerable: true, configurable: true };
      const descriptor = Reflect.getOwnPropertyDescriptor(session, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
