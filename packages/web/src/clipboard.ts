// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Copy text to the clipboard. Prefers the async Clipboard API but falls back to
 * a hidden-textarea `execCommand("copy")` for non-secure contexts (e.g. reaching
 * the node over a plain-http LAN IP), where `navigator.clipboard` is undefined.
 * Returns whether the copy was accepted.
 */
export interface SessionReference {
  url: string;
  sessionId: string;
  node?: string;
  agent?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  sessionFile?: string;
}

/**
 * A paste-ready reference for handing a session to another AI agent. The URL is
 * useful to an agent with browser access, while the stable id and local paths
 * let an agent already running on the node find both the transcript and the
 * exact checkout. In particular, `workspace` alone is not enough for isolated
 * repo sessions: changes live in `worktree`.
 */
export function sessionReferenceText(ref: SessionReference): string {
  const lines = [
    "Bivy session reference",
    `URL: ${ref.url}`,
    `Session ID: ${ref.sessionId}`,
    ref.node ? `Machine: ${ref.node}` : "",
    ref.agent ? `Agent: ${ref.agent}` : "",
    ref.worktree ? `Worktree: ${ref.worktree}` : "",
    ref.workspace ? `Workspace: ${ref.workspace}` : "",
    ref.branch ? `Branch: ${ref.branch}` : "",
    ref.sessionFile ? `Session file: ${ref.sessionFile}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* blocked / not focused — fall through to the legacy path */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
