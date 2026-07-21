/**
 * Fork prerequisite detection (docs/session-fork-plan.md, acceptance: "Missing
 * prerequisites on the destination node are detected and clearly communicated").
 *
 * The engine reports what the destination is missing to continue the forked
 * session so the UI can guide the user instead of failing opaquely:
 *   - agent — the target runtime must be installed/available (a HARD blocker).
 *   - model — the model's provider should have auth on this node (soft: the
 *     runtime can fall back, or the model-auth vault can supply it).
 *   - repo  — the source repo should be reachable (soft: it may be public, or
 *     the user can connect GitHub afterwards).
 *
 * Pure so the server can gather the raw booleans however it likes and this stays
 * unit-testable.
 */

export type ForkPrereqKind = "agent" | "model" | "repo";

export interface ForkPrereq {
  kind: ForkPrereqKind;
  ok: boolean;
  /** Short label for the checklist row. */
  label: string;
  /** One-line explanation of what's wrong / what to do. */
  detail: string;
  /** True when this missing prereq must block the fork (only "agent"). */
  blocking: boolean;
  /** A client-actionable hint, e.g. "runtime.install" / "provider.connect" / "github.connect". */
  fix?: string;
}

export interface ForkPrereqInput {
  agent: { id: string; displayName: string; available: boolean };
  model?: { provider: string; configured: boolean };
  repo?: { slug: string; reachable: boolean };
}

export function evaluateForkPrereqs(input: ForkPrereqInput): ForkPrereq[] {
  const out: ForkPrereq[] = [];

  out.push({
    kind: "agent",
    ok: input.agent.available,
    label: input.agent.displayName,
    detail: input.agent.available
      ? `${input.agent.displayName} is installed on this node.`
      : `${input.agent.displayName} is not installed on this node — install it to continue.`,
    blocking: !input.agent.available,
    ...(input.agent.available ? {} : { fix: "runtime.install" }),
  });

  if (input.model) {
    out.push({
      kind: "model",
      ok: input.model.configured,
      label: input.model.provider,
      detail: input.model.configured
        ? `${input.model.provider} is authenticated on this node.`
        : `${input.model.provider} isn't logged in here — connect it (or the fork will fall back to an available model).`,
      blocking: false,
      ...(input.model.configured ? {} : { fix: "provider.connect" }),
    });
  }

  if (input.repo) {
    out.push({
      kind: "repo",
      ok: input.repo.reachable,
      label: input.repo.slug,
      detail: input.repo.reachable
        ? `${input.repo.slug} is reachable from this node.`
        : `${input.repo.slug} may not be reachable here — connect GitHub if the branch fails to check out.`,
      blocking: false,
      ...(input.repo.reachable ? {} : { fix: "github.connect" }),
    });
  }

  return out;
}

/** The subset that should stop a fork from proceeding (missing + blocking). */
export function blockingForkPrereqs(prereqs: ForkPrereq[]): ForkPrereq[] {
  return prereqs.filter((p) => !p.ok && p.blocking);
}

/** The subset worth surfacing to the user (anything not satisfied). */
export function missingForkPrereqs(prereqs: ForkPrereq[]): ForkPrereq[] {
  return prereqs.filter((p) => !p.ok);
}
