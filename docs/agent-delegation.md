# Cross-agent, cross-machine delegation

An agent in one Bivy session hands a self-contained task to **another agent**,
optionally on **another machine** on the same account, and gets the result back:
Claude asks Codex for a review, Grok runs the Linux-only build on a Linux box
while the Mac-only part runs on a Mac, or one task fans out to several agents to
compare.

This builds on delegated Runs (`src/run-tools.ts`), which already target any
account machine (`machine`), agent (`agent`) and model, with depth
(`maxDepth: 3`) and fan-out (`maxConcurrentChildren: 3`) limits.

## Principles

- **Explicit, never routine.** Agents keep using their own sub-agents for
  ordinary work. Delegation is for when the user asks for another agent or
  machine. An always-on delegation tool made agents spawn sessions for routine
  work, so delegation is a documented CLI (`bivy delegate`) in the Bivy agent
  note, scoped to user requests, not an ambient tool.
- **Agent-agnostic.** A shell command works for every agent (Claude Code,
  Codex, Pi, OpenCode, Grok, …) with no per-agent adapter.
- **Content stays end-to-end encrypted.** The run queue carries the sealed
  instructions and *references* only (child session id, branch, PR), as today;
  the control plane rejects anything transcript-like. The child's **answer** is
  read from the node that ran it: locally when it's this machine, otherwise
  over the existing sealed node-to-node relay client (`SiblingClient`), the
  same channel session replication uses.
- **Work travels by git.** A child that changes code works on its own branch
  and reports it; the parent fetches the branch or reviews the PR.

## Phases

1. **`bivy delegate` (this change).**
   - `bivy delegate "<task>" [--agent <id>] [--machine <name>] [--model <m>]
     [--repo owner/repo] [--wait [seconds]]` starts a delegated Run from the
     calling session (`$BIVY_SESSION_ID`); `status` / `wait <runId>` follow it.
     `bivy nodes` lists the account's machines.
   - When the child finishes, `wait` returns its final answer (bounded) and its
     branch/PR references, whichever machine ran it.
   - The parent transcript shows the call as a **Delegated** card
     (agent @ machine), like a native sub-agent.
2. **Nested children.** Child sessions render under their parent's
   delegation card (live status, tap to open) instead of as unrelated
   top-level sessions; the session list groups them under the parent.
3. **Fan-out and compare.** One task to N agents/machines, each in its own
   worktree, with a side-by-side result view and "adopt this branch".
4. **Discovery.** Per-machine installed agents and capabilities published
   with the machine list, so an agent (and the user) can pick a valid
   agent @ machine up front instead of learning it when the target claims
   the Run.

## Failure modes

- Target machine offline: the Run stays queued. `wait` times out with the
  child still pending, and the parent reports that rather than blocking.
- Agent not installed on the target: the Run fails when claimed, and the
  failure reference says why.
- Answer unreachable (sibling link down): `wait` still returns status and
  references. The answer is omitted and the session can be opened in the app.
