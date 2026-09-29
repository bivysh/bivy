// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bind a loosely written model reference to one entry of a session's catalog.
//
// The CLI (`bivy run --model`, `bivy exec --model`) and the `bivy-model:`
// directive send `{ provider: "", id }`, where `id` may be bare ("gpt-5.6-sol")
// or provider-qualified ("openai-codex/gpt-5.6-sol"). Runtimes key models
// differently — Pi by (provider, id), ACP agents by a slash id whose prefix is
// the provider ("opencode/gpt-5.6-sol") — so a runtime that needs the provider
// (Pi) rejected the bare form and the session silently kept its default model.
// Resolving against the session's own catalog makes every spelling work for any
// runtime without per-agent code.

import type { ModelInfo } from "./types.js";

export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * Resolve `ref` against `models`. An explicit provider is kept as-is. Otherwise
 * match, in order: the exact id, a `provider/id` split, then an id that ends in
 * `/<ref.id>` (a bare name for an ACP slash id). Ties prefer the current
 * model's provider. Unknown refs are returned unchanged so the runtime reports
 * its own error.
 */
export function resolveModelRef(models: readonly ModelInfo[], ref: ModelRef, current?: Pick<ModelInfo, "provider">): ModelRef {
  if (ref.provider) return ref;
  const id = ref.id.trim();
  const slash = id.indexOf("/");
  const tiers = [
    models.filter((m) => m.id === id),
    slash > 0 ? models.filter((m) => m.provider === id.slice(0, slash) && m.id === id.slice(slash + 1)) : [],
    models.filter((m) => m.id.endsWith(`/${id}`)),
  ];
  const candidates = tiers.find((tier) => tier.length) ?? [];
  const pick = candidates.find((m) => m.provider === current?.provider) ?? candidates[0];
  return pick ? { provider: pick.provider, id: pick.id } : ref;
}
