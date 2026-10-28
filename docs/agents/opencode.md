# OpenCode

The open-source OpenCode CLI (`opencode-ai/opencode`), driven under Bivy through
its native Agent Client Protocol server (`opencode acp`): per-tool Approve/Deny,
streaming, native resume, and a model picker populated from the providers you
have actually signed into.

- **Runtime id:** `opencode` · **Tier:** Supported · **In picker:** Yes
- **Release-tested against:** OpenCode 1.19.5 (OpenCode 2.1.4 also checked; see below)

## Install

```bash
npm install --global --prefix ~/.local opencode-ai
```

## Authentication

**Auth owner: agent.** OpenCode's own sign-in is the expected first-run path —
run `opencode` once and follow its prompt (Bivy doesn't drive OpenCode's native
login).

Separately, and automatically: if you've already signed in to a matching model
provider through Bivy's own vault, that credential is forwarded to the
`opencode` process every turn as the provider's standard key variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`, depending on which
model you pick):

```bash
bivy provider login anthropic   # or openai / google
```

Subscription (OAuth) logins other than Anthropic's aren't handed off this way
— those still need OpenCode's own login.

## Models

The model list comes from the ACP session itself, so it lists exactly the models
this node can actually run — whichever providers you've authenticated in OpenCode,
including its own OpenCode Zen catalog. Picking one sends an ACP
`session/set_model`; if the agent rejects it, the selection fails visibly rather
than appearing to apply.

On the fallback pipe path (see below) the picker instead offers the curated
`--model` list, overridable per node with `BIVY_OPENCODE_MODELS` (JSON
`[{id,name?,provider?}]`).

## Resume

Yes — natively, via the ACP `session/load` for the session's own id. On the
fallback pipe path, `opencode run -s <id> "<prompt>"` does the same job.

## Session fork

Yes. A **same-runtime** OpenCode → OpenCode fork is **full** (byte-exact): Bivy
clones the source session's `session`/`message`/`part` rows verbatim through
`exportForFork`/`importForFork`, so the copy keeps every message's full data
rather than a one-text-part-per-turn summary.

Cross-runtime forks *into* OpenCode are **replayed**, not seeded. Bivy
writes the fork's portable `{role, text}` transcript as a real session in
OpenCode's own store (`$XDG_DATA_HOME/opencode/opencode.db` — `session`,
`message`, and `part` rows mirroring OpenCode's own layout), so `session/load`
resumes it and the model opens on the full conversation instead of a summary
prompt. Best-effort like Codex's replay: if the node's OpenCode store is missing
or on an unknown schema, the fork degrades to the seeded continuation prompt;
`BIVY_OPENCODE_NO_FORK_REPLAY=1` forces that fallback.

## OpenCode 2

OpenCode 2 is a separate install (`opencode upgrade --major`, or the
`@opencode/cli` package); `opencode-ai` on npm stays on 1.x. Bivy drives both
through `opencode acp`.

OpenCode 2 keeps sessions in new tables (`session_v2`, `session_message`). Bivy
detects that store and reads it directly, but writes only through OpenCode's own
CLI: a fork or a cross-agent replay becomes `opencode session import
--standalone`, and deleting a session in the app runs `opencode session delete
--standalone`. `--standalone` keeps these commands from starting OpenCode's
background service.

OpenCode 2 no longer reads `auth.json` or `OPENCODE_AUTH_CONTENT`, so a ChatGPT
plan connected in Bivy does not reach it. Sign in with `opencode auth login` on
the node. API keys in Bivy's vault still arrive as environment variables.

## How it runs (and the version fallback)

Bivy drives OpenCode through its native
[Agent Client Protocol](https://agentclientprotocol.com) server by default:

```bash
opencode acp   # what Bivy launches, wrapped by bin/acp-shim.mjs
```

That path is what earns the Supported tier — per-tool Approve/Deny, streaming,
`session/load` resume, and real model selection.

Because ACP has no mid-session fallback, the promotion is **gated on your
installed binary actually having the `acp` subcommand** (a cached `--help`
probe). An OpenCode too old to offer it keeps the original one-shot pipe path
(`opencode run`), and the picker honestly reports the reduced capabilities:
effect-level sandbox governance instead of per-tool cards. Upgrade OpenCode to
get the governed path.

To force the pipe path back on a node:

```bash
BIVY_OPENCODE_ACP=0 bivy run opencode
```

See [acp.md](acp.md).

## Known gaps

- On the fallback pipe path, governance is effect-level (sandbox tier /
  FS-MCP-network channels) rather than per-tool approval cards.
- No package installs through this runtime.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_OPENCODE_ARGS` if a version differs.

## Run it

Pick OpenCode in the agent picker, or:

```bash
bivy run opencode
```
