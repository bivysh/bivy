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
 * Map a runtime's loose model record into the neutral `ModelInfo`.
 *
 * Field resolution is the lenient superset of what the per-runtime versions did:
 *   - id:            `id` → `model` → String(model)
 *   - name:          `displayName` → `name` → id
 *   - reasoning:     `reasoning` || `supportsThinking`
 *   - maxTokens:     `maxTokens` → `maxOutputTokens`
 *   - input/configured: passed through only when present (key stays absent otherwise)
 */
export function toModelInfo(model: any, opts: ToModelInfoOptions = {}): ModelInfo {
  const id = model?.id ?? model?.model ?? String(model);
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
