# OpenCode

The open-source OpenCode CLI (`opencode-ai/opencode`), run non-interactively
under Bivy (`opencode run`) with structured streaming and resume.

- **Runtime id:** `opencode` · **Tier:** Beta · **In picker:** Yes

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
bivy login anthropic   # or openai / google
```

Subscription (OAuth) logins other than Anthropic's aren't handed off this way
— those still need OpenCode's own login.

## Models

Wired to OpenCode's `--model` flag with a curated default list:

| id | name |
| --- | --- |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `openai/gpt-5` | GPT-5 |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |

Override the list per node with `BIVY_OPENCODE_MODELS` (JSON
`[{id,name?,provider?}]`).

## Resume

Yes — `opencode run -s <id> "<prompt>"` continues a prior session by
OpenCode's own session id.

## Known gaps

- Governance is effect-level (sandbox tier / FS-MCP-network channels), not
  per-tool approval cards — `toolInterception` is off for this runtime.
- No package installs or session fork through this runtime.
- Launch flags are pinned against the documented CLI; override with
  `BIVY_OPENCODE_ARGS` if a version differs.

## Run it

Pick OpenCode in the agent picker, or:

```bash
bivy run opencode
```
