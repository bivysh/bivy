// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Automations an agent proposes (`bivy automation apply` inside a session).
 * Automations outlive the session and run unattended on the user's account, so
 * an agent never applies them itself: the node works out what would change
 * (`automation apply --dry-run`), asks the user with an approval card, and only
 * then runs the apply, with the machine's own account credential.
 */
export interface AutomationChange {
  id: string;
  action: "create" | "update" | "remove";
  name?: string;
  enabled?: boolean;
  trigger?: string;
  schedule?: { kind: string; at?: string; expression?: string; timezone?: string };
  workspace?: string;
  agent?: string;
  sandbox?: string;
  approval?: string;
}

export type ProposalStatus = "pending" | "applied" | "failed" | "rejected" | "expired";

export interface AutomationProposal {
  id: string;
  sessionId: string;
  status: ProposalStatus;
  /** The file, relative to the workspace. */
  file: string;
  changes: AutomationChange[];
  /** What apply printed (webhook URLs and one-time secrets included). */
  output?: string;
  error?: string;
}

export interface CliRun { code: number; stdout: string; stderr: string }

export interface AutomationProposalDeps {
  /** Runs `bivy automation …` directly (not proposed again), in `cwd`. */
  runCli(args: string[], cwd: string): Promise<CliRun>;
  /** Shows the approval card; resolves with the user's decision. */
  requestApproval(input: { id: string; sessionId: string; file: string; changes: AutomationChange[]; prune: boolean }): Promise<"approved" | "rejected" | "expired">;
}

/** One line per change, for the card and the CLI. */
export function describeChange(change: AutomationChange): string {
  if (change.action === "remove") return `Remove ${change.id}`;
  const when = change.schedule?.kind === "cron" ? `${change.schedule.expression} (${change.schedule.timezone})` : change.schedule?.kind === "once" ? `once at ${change.schedule.at}` : change.trigger ?? "";
  const verb = change.action === "create" ? "Add" : "Update";
  return `${verb} ${change.name ?? change.id}${change.enabled === false ? " (off)" : ""}: ${when}${change.workspace ? ` in ${change.workspace}` : ""}, ${change.agent}, ${change.sandbox}, approvals ${change.approval}`;
}

/** `file` resolved inside `workspace`, or an error: an agent can only propose its own workspace's files. */
export function confinedFile(workspace: string, file: string): { abs: string; rel: string } | { error: string } {
  let root: string;
  let abs: string;
  try {
    root = fs.realpathSync(workspace);
    abs = fs.realpathSync(path.resolve(workspace, file));
  } catch {
    return { error: `No such file: ${file}` };
  }
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { error: "The automations file must be inside the session workspace." };
  return { abs, rel };
}

const KEEP_MS = 24 * 60 * 60 * 1000;

export class AutomationProposals {
  private readonly proposals = new Map<string, AutomationProposal & { settledAt?: number }>();

  constructor(private readonly deps: AutomationProposalDeps, private readonly now: () => number = Date.now) {}

  /** Check the file, work out the changes, and put the card in front of the user. */
  async propose(sessionId: string, workspace: string, file: string, prune: boolean): Promise<AutomationProposal | { error: string }> {
    this.prune();
    const target = confinedFile(workspace, file);
    if ("error" in target) return target;
    const dry = await this.deps.runCli(["automation", "apply", target.abs, "--dry-run", "--json", ...(prune ? ["--prune"] : [])], workspace);
    if (dry.code !== 0) return { error: (dry.stderr || dry.stdout).trim().replace(/^Automation error: /, "") || "The automations file could not be checked." };
    let changes: AutomationChange[];
    try { changes = (JSON.parse(dry.stdout) as { changes: AutomationChange[] }).changes; } catch { return { error: "Unexpected output from automation apply --dry-run." }; }
    if (!changes.length) return { error: "The file has no automations to apply." };
    const proposal: AutomationProposal & { settledAt?: number } = { id: randomUUID(), sessionId, status: "pending", file: target.rel, changes };
    this.proposals.set(proposal.id, proposal);
    void this.deps.requestApproval({ id: proposal.id, sessionId, file: target.rel, changes, prune }).then(async (decision) => {
      if (decision === "approved") {
        const run = await this.deps.runCli(["automation", "apply", target.abs, ...(prune ? ["--prune"] : [])], workspace);
        proposal.status = run.code === 0 ? "applied" : "failed";
        proposal.output = run.stdout.trim();
        if (run.code !== 0) proposal.error = run.stderr.trim().replace(/^Automation error: /, "");
      } else proposal.status = decision;
      proposal.settledAt = this.now();
    });
    return this.view(proposal);
  }

  get(sessionId: string, id: string): AutomationProposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal && proposal.sessionId === sessionId ? this.view(proposal) : undefined;
  }

  private view({ settledAt: _settledAt, ...proposal }: AutomationProposal & { settledAt?: number }): AutomationProposal {
    return structuredClone(proposal);
  }

  private prune(): void {
    for (const [id, proposal] of this.proposals) if (proposal.settledAt !== undefined && this.now() - proposal.settledAt > KEEP_MS) this.proposals.delete(id);
  }
}
