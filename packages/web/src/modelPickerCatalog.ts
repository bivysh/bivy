// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { ModelInfo } from "@bivy/core";

const LATEST = " (latest)";

const providerOf = (model: ModelInfo) => String((model as { provider?: unknown }).provider ?? "");
const nameOf = (model: ModelInfo) => model.label || model.id;

/** The first version number in a model's name ("Claude Opus 4.8" → [4, 8]). */
function versionOf(model: ModelInfo): number[] {
  const match = nameOf(model).match(/\d+(?:\.\d+)*/);
  return match ? match[0].split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Connected models as the picker lists them: each provider keeps its place,
 *  its newest versions first, and a dated model is dropped when the provider
 *  also lists it as "(latest)" (the same model, kept current). */
export function orderConnectedModels(models: readonly ModelInfo[]): ModelInfo[] {
  const latest = new Set(models.filter((m) => nameOf(m).endsWith(LATEST)).map((m) => `${providerOf(m)}\0${nameOf(m).slice(0, -LATEST.length)}`));
  const providers = [...new Set(models.map(providerOf))];
  return models
    .filter((m) => !latest.has(`${providerOf(m)}\0${nameOf(m)}`))
    .map((model, index) => ({ model, index }))
    .sort((a, b) =>
      providers.indexOf(providerOf(a.model)) - providers.indexOf(providerOf(b.model))
      || compareVersions(versionOf(a.model), versionOf(b.model))
      || a.index - b.index)
    .map(({ model }) => model);
}
