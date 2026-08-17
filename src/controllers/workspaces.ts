// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Workspace controller — the saved-workspace list domain lifted out of
// server.ts. Owns path resolution/validation and the saved-workspace list
// persistence that the RELAY_COMMANDS
// `workspaces.list` handler and the REST `/api/workspaces` routes share.
// server.ts wires it with the settings accessors + metadata store and keeps the
// bare helper names, so every call site is unchanged.
//
// Note: session-time project policy (`assertProjectModel`, `projectSafety`)
// stays in server.ts — it is woven into session creation, not the workspace
// list domain. Imports nothing from server.ts (boundary enforced).
import fs from "node:fs";
import path from "node:path";

/** The subset of the node metadata store the workspace domain needs. */
export interface WorkspaceMetadata {
  listWorkspaces(): string[];
  rememberWorkspace(workspace: string): void;
  removeWorkspace(workspace: string): void;
}

export interface WorkspaceControllerDeps {
  readSettings(): Record<string, unknown>;
  writeSettings(settings: Record<string, unknown>): void;
  metadata: WorkspaceMetadata;
}

export function createWorkspaceController({ readSettings, writeSettings, metadata }: WorkspaceControllerDeps) {
  const resolveWorkspacePath = (value: unknown): string => {
    const raw = String(value ?? "").trim();
    if (!raw) throw new Error("Workspace path is required");
    const expanded = raw.startsWith("~") ? path.join(process.env.HOME ?? "", raw.slice(1)) : raw;
    return path.resolve(expanded);
  };

  const validateWorkspace = (value: unknown): string => {
    const resolved = resolveWorkspacePath(value);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    return resolved;
  };

  const loadSavedWorkspaces = (): string[] => {
    const settings = readSettings();
    const list = [...metadata.listWorkspaces(), ...(Array.isArray(settings.workspaces) ? settings.workspaces : [])];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
      const value = String(item ?? "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };

  const saveWorkspaces = (list: string[]): void => {
    const settings = readSettings();
    settings.workspaces = list;
    writeSettings(settings);
    for (const workspace of list) metadata.rememberWorkspace(workspace);
  };

  /** Record a workspace as most-recently-used. Best-effort; never throws. */
  const rememberWorkspace = (workspace: string): void => {
    try {
      const resolved = path.resolve(workspace);
      const list = loadSavedWorkspaces().filter((item) => item !== resolved);
      list.unshift(resolved);
      saveWorkspaces(list);
    } catch {
      // ignore persistence errors
    }
  };

  const addSavedWorkspace = (value: unknown): string[] => {
    const resolved = validateWorkspace(value);
    const list = loadSavedWorkspaces().filter((item) => item !== resolved);
    list.unshift(resolved);
    saveWorkspaces(list);
    return loadSavedWorkspaces();
  };

  const removeSavedWorkspace = (value: unknown): string[] => {
    const resolved = resolveWorkspacePath(value);
    const list = loadSavedWorkspaces().filter((item) => item !== resolved);
    metadata.removeWorkspace(resolved);
    saveWorkspaces(list);
    return loadSavedWorkspaces();
  };

  return {
    resolveWorkspacePath,
    validateWorkspace,
    loadSavedWorkspaces,
    saveWorkspaces,
    rememberWorkspace,
    addSavedWorkspace,
    removeSavedWorkspace,
  };
}
