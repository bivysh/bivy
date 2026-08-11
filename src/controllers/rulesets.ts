// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Ruleset controller — the ruleset operation domain lifted out of server.ts as
// the first bounded-controller carve (platform modularization Phase 2; see
// docs/internal/platform-modularization-plan.md). It owns the ruleset helpers
// that the RELAY_COMMANDS handlers, the REST `/api/rulesets` routes, and the
// queue run-policy all share, behind injected node capabilities. `server.ts`
// wires it and keeps the bare helper names, so every current call site is
// unchanged.
//
// A controller imports NOTHING from server.ts — the dependency direction is
// server -> controller only, enforced by scripts/check-module-boundaries.mjs.
import { listRulesetInfos, upsertRuleset, removeRuleset, activeRulesetFor } from "../runtime/ruleset-store.js";
import type { Ruleset } from "../policy/ruleset.js";

export interface RulesetControllerDeps {
  /** Directory the ruleset store persists to. */
  rulesetsDir: string;
  /** Re-emit an event to every connected client (relay + direct sockets). */
  broadcast(event: unknown): void;
}

export interface RulesetController {
  /** Non-secret ruleset metadata for enumeration. */
  rulesetInfos(): ReturnType<typeof listRulesetInfos>;
  /** Re-emit the ruleset list to every connected client (relay + direct). */
  broadcastRulesets(): void;
  /** Save (validate + store) a ruleset; `active` optionally (de)selects it as
   *  the queue's active ruleset. Returns the stored name. */
  persistRulesetSave(input: unknown, active?: boolean): { name: string };
  persistRulesetRemove(name: string): void;
  /** The ruleset the work queue should run under right now: the user's active
   *  ruleset if it applies to the queue, else undefined (→ DEFAULT_RULESET).
   *  Read lazily on each decision so UI edits take effect without a restart. */
  activeQueueRuleset(): Ruleset | undefined;
}

export function createRulesetController({ rulesetsDir, broadcast }: RulesetControllerDeps): RulesetController {
  const rulesetInfos = () => listRulesetInfos(rulesetsDir);

  const broadcastRulesets = (): void => {
    broadcast({ type: "rulesets.list", rulesets: rulesetInfos() });
  };

  const persistRulesetSave = (input: unknown, active?: boolean): { name: string } => {
    const result = upsertRuleset(rulesetsDir, input, active);
    broadcastRulesets();
    return result;
  };

  const persistRulesetRemove = (name: string): void => {
    removeRuleset(rulesetsDir, name);
    broadcastRulesets();
  };

  const activeQueueRuleset = (): Ruleset | undefined => activeRulesetFor(rulesetsDir, "queue");

  return { rulesetInfos, broadcastRulesets, persistRulesetSave, persistRulesetRemove, activeQueueRuleset };
}
