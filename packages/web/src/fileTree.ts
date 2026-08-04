// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure projections for the changed-file review surface (C3): a directory tree
// over the flat changed-file list, and the set of "which state am I reviewing"
// badges (working tree / checkpoint / branch / commit / PR). Kept free of React
// so they can be unit-tested without a DOM.

export interface FileTreeFile {
  path: string;
  status: "added" | "modified" | "deleted";
  added?: number;
  removed?: number;
}

export interface FileTreeNode {
  name: string;
  /** Full path for a file; the directory path for a dir. */
  path: string;
  type: "dir" | "file";
  children?: FileTreeNode[];
  file?: FileTreeFile;
}

/**
 * Build a nested directory tree from a flat changed-file list. Directories sort
 * before files, each alphabetically; a single-child directory chain is collapsed
 * into one "a/b/c" node (like GitHub) so deep paths stay compact.
 */
export function buildFileTree(files: FileTreeFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", type: "dir", children: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i]!;
      const path = parts.slice(0, i + 1).join("/");
      node.children ??= [];
      let child = node.children.find((c) => c.name === name && c.type === (isLeaf ? "file" : "dir"));
      if (!child) {
        child = isLeaf ? { name, path, type: "file", file } : { name, path, type: "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortLevel = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    for (const n of nodes) if (n.children) n.children = collapse(sortLevel(n.children));
    return nodes;
  };
  // Collapse a dir with exactly one dir child into "parent/child".
  const collapse = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes.map((n) => {
      let cur = n;
      while (cur.type === "dir" && cur.children?.length === 1 && cur.children[0]!.type === "dir") {
        const only = cur.children[0]!;
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      return cur;
    });
  return collapse(sortLevel(root.children ?? []));
}

export type ReviewState = "working-tree" | "checkpoint" | "branch" | "commit" | "pull-request";

const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  "working-tree": "Working tree",
  checkpoint: "Checkpoint",
  branch: "Branch",
  commit: "Commit",
  "pull-request": "Pull request",
};

export function reviewStateLabel(state: ReviewState): string {
  return REVIEW_STATE_LABEL[state];
}

/**
 * Which review states a run currently spans (C3b) — so the surface says whether
 * you're looking at uncommitted working-tree edits, a rewindable checkpoint, a
 * pushed branch/commit, or an opened PR, rather than conflating them. Ordered
 * from most-local to most-shared.
 */
export function reviewStates(opts: {
  hasWorkingChanges?: boolean;
  hasCheckpoint?: boolean;
  output?: { branch?: string; commit?: string; prUrl?: string } | undefined;
}): ReviewState[] {
  const states: ReviewState[] = [];
  if (opts.hasWorkingChanges) states.push("working-tree");
  if (opts.hasCheckpoint) states.push("checkpoint");
  if (opts.output?.branch) states.push("branch");
  if (opts.output?.commit) states.push("commit");
  if (opts.output?.prUrl) states.push("pull-request");
  return states;
}
