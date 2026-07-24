// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Shared runtime normalization helpers (docs/dramatic-simplification-plan.md,
// slice 3). Every runtime adapter has to turn its own model shape into the
// runtime-neutral `ModelInfo`. Each used to reimplement that mapping (pi.ts,
// claude-code.ts, …), so the same field had subtly different fallbacks per
// runtime. This is the one home for that mapping; adapters pass their per-runtime
// quirks (default provider, whether the model is `configured`) as options.
//
// Pure and defensive — a bare string, a `{model}` blob, or a rich record all map
// without throwing — so it is unit-testable without a live agent (see
// test/runtime-normalize.test.ts).

import type { ModelInfo } from "./types.js";

export interface ToModelInfoOptions {
  /** Provider to assume when the model record carries none (e.g. Claude → "anthropic"). */
  defaultProvider?: string;
  /** Whether the node holds credentials for this model's provider. Omitted → field absent. */
  configured?: boolean;
}

/**
 * Pull a usable string model id out of a loose record.
 *
 * A runtime (e.g. the Claude Agent SDK's `supportedModels()`) can hand us a
 * record whose id lives under a field other than `id`/`model`, or whose `model`
 * is itself a nested object (`{ model: { id, displayName } }`). The old
 * `id ?? model ?? String(model)` chain coerced those objects with `String()`,
 * yielding the literal string "[object Object]" — which then flowed all the way
 * to the agent CLI as a model id and was rejected ("Model '[object Object]' is
 * not a recognized model id"). Resolve defensively and never stringify an
 * object into an id: try the known id-bearing fields, recurse into a nested
 * `model` object, and only fall back to `String()` for a primitive.
 */
function resolveModelId(model: any): string {
  if (model == null) return "";
  if (typeof model === "string") return model;
  if (typeof model === "number") return String(model);
  if (typeof model === "object") {
    for (const key of ["id", "model", "value", "slug", "name"]) {
      const candidate = (model as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate) return candidate;
      // `model.model` (and friends) can be a nested record — dig in.
      if (candidate && typeof candidate === "object") {
        const nested = resolveModelId(candidate);
        if (nested) return nested;
      }
    }
    return "";
  }
  return String(model);
}

/**
 * Map a runtime's loose model record into the neutral `ModelInfo`.
 *
 * Field resolution is the lenient superset of what the per-runtime versions did:
 *   - id:            `id` → `model` → nested `model.*` id → `value`/`slug`/`name`
 *   - name:          `displayName` → `name` → id
 *   - reasoning:     `reasoning` || `supportsThinking`
 *   - maxTokens:     `maxTokens` → `maxOutputTokens`
 *   - input/configured: passed through only when present (key stays absent otherwise)
 */
export function toModelInfo(model: any, opts: ToModelInfoOptions = {}): ModelInfo {
  const id = resolveModelId(model);
  const info: ModelInfo = {
    provider: model?.provider ?? opts.defaultProvider ?? "",
    id,
    name: model?.displayName ?? model?.name ?? id,
    reasoning: Boolean(model?.reasoning ?? model?.supportsThinking),
    contextWindow: model?.contextWindow,
    maxTokens: model?.maxTokens ?? model?.maxOutputTokens,
  };
  if (model?.input !== undefined) info.input = model.input;
  if (opts.configured != null) info.configured = opts.configured;
  return info;
}
