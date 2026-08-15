// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { TSchema } from "typebox";
import { validateInput, type CommandCtx, type CommandHandler } from "./command-spec.js";

export type RegisteredCommand<I> = CommandHandler<I> | { since?: number; schema?: TSchema; handler: CommandHandler<I> };
export type CommandEntries<I> = Record<string, RegisteredCommand<I>>;
export type CommandSchemas = Readonly<Record<string, TSchema>>;

export interface CommandDispatchResult {
  handled: boolean;
  valid: boolean;
}

/**
 * Transport-neutral command lookup and validation. Relay/WebSocket adapters only
 * supply a context; operation identity, schemas, and handlers have one home.
 */
export class CommandRegistry<I extends Record<string, unknown>> {
  constructor(
    private readonly entries: CommandEntries<I>,
    private readonly schemas: CommandSchemas = {},
  ) {}

  has(kind: string): boolean {
    return this.entries[kind] !== undefined;
  }

  async dispatch(kind: string, input: I, ctx: CommandCtx): Promise<CommandDispatchResult> {
    const entry = this.entries[kind];
    if (!entry) return { handled: false, valid: true };
    const handler = typeof entry === "function" ? entry : entry.handler;
    const schema = this.schemas[kind] ?? (typeof entry === "function" ? undefined : entry.schema);
    const checked = validateInput(schema, input);
    if (!checked.ok) {
      ctx.reply({
        type: `${kind}.error`,
        requestId: typeof input.requestId === "string" ? input.requestId : undefined,
        error: `Invalid ${kind}: ${checked.errors.join("; ")}`,
      });
      return { handled: true, valid: false };
    }
    await handler(checked.value as I, ctx);
    return { handled: true, valid: true };
  }
}
