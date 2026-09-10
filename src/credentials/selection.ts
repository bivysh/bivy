// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path";
import { resolveCredential, type CredentialRecord, type CredentialPresets } from "./records.js";
import type { CredentialContext } from "./types.js";

/** Stable project identifiers discoverable without importing repo/session code. */
export function projectIdsFromWorkspace(workspace: string): string[] {
  const resolved = path.resolve(workspace);
  const ids = new Set<string>([resolved, path.basename(resolved)]);
  for (const part of resolved.split(path.sep)) {
    const split = part.indexOf("__");
    if (split > 0 && split < part.length - 2) ids.add(`${part.slice(0, split)}/${part.slice(split + 2)}`);
  }
  return [...ids];
}

export function selectCredential(provider: string, records: readonly CredentialRecord[], presets: CredentialPresets, context?: CredentialContext) {
  const id = provider.trim().toLowerCase();
  const workspace = context?.workspace?.trim();
  const projects = [context?.project?.trim(), ...(workspace ? projectIdsFromWorkspace(workspace) : [])].filter(Boolean);
  const projectPreset = projects.map((value) => `project:${value}`).find((name) => presets.presets?.[name]?.[id]);
  return resolveCredential(id, records, presets, {
    ...(projectPreset ? { preset: projectPreset } : {}),
    ...(context?.preferLabel ? { preferLabel: context.preferLabel } : {}),
  });
}
