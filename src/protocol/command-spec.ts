// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Schema-capable command specification (platform modularization Phase 2). A
// command in the dispatch registry can carry a typebox input schema; when
// present, the transport boundary validates the raw message against it BEFORE
// dispatch, so handlers receive typed, validated input instead of the ad-hoc
// `typeof msg.x === ...` casting scattered through server.ts today.
//
// Additive by design: a spec without a schema passes its input through
// unchecked, so unschematized commands behave exactly as they do now and the
// registry can be migrated one command at a time.
import type { TSchema, Static } from "typebox";
import { Check, Errors } from "typebox/value";

import type { VersionedOp } from "./version.js";

/** Answers the calling client (reply) or every connected client (broadcast). */
export interface CommandCtx {
  reply(event: unknown): void;
  broadcast(event: unknown): void;
}

export type CommandHandler<I> = (input: I, ctx: CommandCtx) => void | Promise<void>;

/**
 * A registry entry: the protocol version it was introduced at (for the
 * compatible-subset policy), an optional input schema validated at the boundary,
 * and the handler that receives the validated input.
 */
export interface CommandSpec<S extends TSchema = TSchema> extends VersionedOp {
  schema?: S;
  handler: CommandHandler<Static<S>>;
}

export interface ValidationOk<T> {
  ok: true;
  value: T;
}
export interface ValidationErr {
  ok: false;
  errors: string[];
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

/**
 * Validate a raw message against a schema. No schema → pass through unchecked
 * (migration-friendly). On failure, returns bounded, path-qualified messages
 * suitable for a `*.error` reply — never throws.
 */
export function validateInput<S extends TSchema>(schema: S | undefined, msg: unknown): ValidationResult<Static<S>> {
  if (!schema) return { ok: true, value: msg as Static<S> };
  if (Check(schema, msg)) return { ok: true, value: msg as Static<S> };
  const errors = [...Errors(schema, msg)].slice(0, 20).map((e) => `${e.path || "/"}: ${e.message}`);
  return { ok: false, errors: errors.length ? errors : ["invalid input"] };
}
