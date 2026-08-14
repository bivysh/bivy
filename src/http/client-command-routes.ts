// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type express from "express";
import type { CommandCtx } from "../protocol/command-spec.js";
import type { CommandRegistry } from "../protocol/command-registry.js";
import type { ClientCommandRoute } from "../protocol/client-command-routes.js";

function httpReply(res: express.Response, event: unknown): void {
  if (!event || typeof event !== "object") {
    res.json(event);
    return;
  }
  const { type: _type, httpStatus, ...body } = event as Record<string, unknown>;
  const status = typeof httpStatus === "number" ? httpStatus : 200;
  res.status(status).json(body);
}

/** Register direct HTTP framing for canonical client commands. Handlers and
 * validation remain in CommandRegistry; this adapter only maps request/reply. */
export function bindClientCommandRoutes<I extends { kind: string }>(
  app: express.Express,
  registry: CommandRegistry<I>,
  routes: readonly ClientCommandRoute[],
  broadcast: CommandCtx["broadcast"],
): void {
  for (const route of routes) {
    app[route.method](route.path, async (req, res, next) => {
      let replied = false;
      const ctx: CommandCtx = {
        reply(event) {
          if (replied) return;
          replied = true;
          httpReply(res, event);
        },
        broadcast,
      };
      try {
        const input = { ...(req.body ?? {}), kind: route.kind } as I;
        const result = await registry.dispatch(route.kind, input, ctx);
        if (!result.handled) return next(new Error(`No command handler registered for ${route.kind}`));
        if (!replied) httpReply(res, { ok: true });
      } catch (error) {
        next(error);
      }
    });
  }
}
