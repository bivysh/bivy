// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import path from "node:path";

/**
 * The autonomy boundary.
 *
 * Bivy runs agents without per-action approval by default. Safety comes not from
 * prompting on every tool call but from a hard floor that holds in *every* mode:
 * catastrophic commands and writes outside the workspace are blocked outright.
 * Above that floor, `approvalMode` decides how chatty to be.
 *
 * Pure functions only (no daemon state) so they are unit-testable in isolation —
 * see `test/autonomy.test.ts`.
 */

export type ApprovalMode = "never" | "risky" | "always" | "autonomous";
export type GuardDecision = "allow" | "ask" | "deny";

export function bashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  // Structured agents use different names for their shell surface. Keep this
  // intentionally small and factual; unknown tools are not magically governed.
  for (const key of ["command", "cmd", "script"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return "";
}

/** Heuristic for the legacy "risky" mode (prompt-heavy). */
export function looksRiskyBash(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /(^|[;&|()\s])(rm|rmdir|mv|cp|chmod|chown|dd|mkfs|sudo|su|kill|pkill|curl|wget|git\s+(commit|push|reset|clean|checkout|switch|merge|rebase)|npm\s+(install|update|publish)|pnpm\s+(install|update|publish)|yarn\s+(add|install|upgrade|publish))([;&|()\s]|$)/.test(normalized) ||
    /(^|\s)(>|>>|2>|&>|tee\s+)/.test(normalized)
  );
}

/** Parse dangerous recursive rm targets without a nested-quantifier regex. The
 * input is user/agent controlled, so this intentionally stays linear-time. */
function catastrophicRm(command: string): boolean {
  const systemRoots = ["/etc", "/usr", "/home", "/var", "/opt", "/boot", "/root", "/bin", "/sbin", "/lib", "/lib64"];
  for (const segment of command.split(/[;\n|&]+/)) {
    const tokens = segment.trim().split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ""));
    const rmIndex = tokens.lastIndexOf("rm");
    if (rmIndex < 0) continue;
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const token of tokens.slice(rmIndex + 1)) {
      if (token === "--recursive") recursive = true;
      else if (token === "--force") force = true;
      else if (token.startsWith("-") && !token.startsWith("--")) {
        recursive ||= token.includes("r") || token.includes("R");
        force ||= token.includes("f");
      } else if (!token.startsWith("--")) targets.push(token);
    }
    if (!recursive || !force) continue;
    for (const rawTarget of targets) {
      const target = rawTarget.length > 1 ? rawTarget.replace(/\/+$/, "") : rawTarget;
      if (target === "/" || target === "~" || target === "$home" || target === "/*") return true;
      if (systemRoots.some((root) => target === root || target.startsWith(`${root}/`))) return true;
    }
  }
  return false;
}

/**
 * Catastrophic, irreversible, system-wide actions. Blocked OUTRIGHT in every mode
 * — the boundary that makes unattended autonomy safe rather than reckless.
 */
export function looksCatastrophic(command: string): boolean {
  const c = command.trim().toLowerCase().slice(0, 100_000);
  if (!c) return false;
  return (
    catastrophicRm(c) || // rm -rf / | ~ | system roots
    /\bmkfs(\.\w+)?\b/.test(c) ||
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)/.test(c) ||
    />\s*\/dev\/(sd|nvme|hd|disk)/.test(c) ||
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c) || // fork bomb
    /\bchmod\s+-\S*r\S*\s+777\s+\/(\s|$)/.test(c) ||
    /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)\b/.test(c)
  );
}

/**
 * Irreversible / outward-facing actions that pause for a human even in autonomous
 * mode (the "backstop"): publishing, deploying, force-pushing, pushing to the
 * default branch, privilege escalation.
 */
export function looksBackstop(command: string): boolean {
  const c = command.trim().toLowerCase();
  if (!c) return false;
  return (
    /\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b)/.test(c) ||
    /\bgit\s+push\b[^\n]*\b(main|master)\b/.test(c) ||
    /\bnpm\s+publish\b/.test(c) ||
    /\b(kubectl\s+apply|terraform\s+apply|docker\s+push|fly\s+deploy|vercel\s+(deploy|--prod)|netlify\s+deploy|gh\s+release\s+create)\b/.test(c) ||
    /(^|[;&|]\s*)(mail|mailx|sendmail|ssmtp)\b/.test(c) || // send email from the shell
    /(^|[;&|]\s*)sudo\b/.test(c)
  );
}

/** Extract a filesystem path from a write/edit tool input, if present. */
export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  return undefined;
}

/** True if `p` resolves outside `workspace` (so a write there escapes the boundary). */
export function pathEscapesWorkspace(workspace: string, p: string): boolean {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, p);
  return abs !== root && !abs.startsWith(root + path.sep);
}

/**
 * Decide what to do with a tool call. The hard floor (catastrophic commands,
 * writes outside the session workspace) applies in every mode. Above that floor,
 * `mode` decides how often to prompt.
 */
export function guardToolCall(
  workspace: string,
  toolName: string,
  input: unknown,
  mode: ApprovalMode,
  isRiskyIntegration: (tool: string) => boolean,
): { decision: GuardDecision; reason?: string } {
  // Built-in tool names arrive with runtime-specific casing: the Claude Code SDK
  // sends `Bash`/`Write`/`Edit` verbatim, while Pi/others send lowercase. Match
  // case-insensitively so the hard floor below fires for every runtime — a
  // case-sensitive compare silently disabled it for claude-code. Integration
  // tool names (MCP, etc.) keep their original casing via `isRiskyIntegration`.
  const tool = toolName.toLowerCase();
  const isShell = tool === "bash" || tool === "shell" || tool === "execute" || tool === "run_command";
  // Tools that write to the filesystem and so must respect the workspace
  // boundary. MultiEdit/NotebookEdit also take a `file_path` (see toolPath).
  const isWrite = tool === "write" || tool === "edit" || tool === "multiedit" || tool === "notebookedit";

  // --- Hard floor: blocked in every mode ---
  if (isShell && looksCatastrophic(bashCommand(input))) {
    return { decision: "deny", reason: "Blocked: catastrophic command (outside the safety boundary)" };
  }
  if (isWrite) {
    const p = toolPath(input);
    if (p && pathEscapesWorkspace(workspace, p)) {
      return { decision: "deny", reason: "Blocked: write outside the workspace boundary" };
    }
  }

  if (mode === "never") return { decision: "allow" };

  // Integration tools flagged risky (send email, upload, ...) always confirm.
  if (isRiskyIntegration(toolName)) return { decision: "ask" };

  if (mode === "autonomous") {
    if (isShell && looksBackstop(bashCommand(input))) return { decision: "ask" };
    return { decision: "allow" };
  }
  if (mode === "always") {
    return { decision: isShell || isWrite ? "ask" : "allow" };
  }
  // "risky"
  if (isShell) return { decision: looksRiskyBash(bashCommand(input)) ? "ask" : "allow" };
  return { decision: isWrite ? "ask" : "allow" };
}
