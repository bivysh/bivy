# Claude Code

Anthropic's Claude Agent SDK, driven as a Bivy runtime: streaming turns, model
picker, and tool approvals via the SDK's `canUseTool` permission callback.

- **Runtime id:** `claude-code-sdk` · **Tier:** Supported · **In picker:** Yes

## Install

The SDK is an optional dependency of Bivy, not the agent picker's default:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

Until it's installed, this runtime shows as "planned" in the catalog.
Separately, if you also want the native `claude` CLI's own terminal UI
available for hand-off (see below), install and put that CLI on `PATH`
yourself — Bivy only detects whether it's there, it doesn't install it.

## Authentication

**Auth owner: mixed.** Bivy's shared vault covers the SDK path; the standalone
`claude` CLI, if you use it, owns its own login.

- **Bivy vault (recommended):** sign in to Anthropic once and Bivy injects it
  into the SDK subprocess — an OAuth (Claude Pro/Max) credential as
  `CLAUDE_CODE_OAUTH_TOKEN`, or an API key as `ANTHROPIC_API_KEY`.

  ```bash
  bivy login anthropic
  ```

- **Native CLI login:** if you run `claude` directly (e.g. for the interactive
  TUI hand-off), it can also sign in itself:

  ```bash
  claude    # then /login inside the CLI if it doesn't prompt automatically
  ```

If neither is configured, the first turn fails fast with an actionable message
instead of an opaque 401.

## Models

Comes from the live SDK query (`supportedModels()`) once a session is running.
Before that, the picker shows the known Claude Pro/Max lineup: Opus 4.8, Sonnet
5, Haiku 4.5. Set a session default with:

```
BIVY_CLAUDE_MODEL=claude-opus-4-8
```

## Resume

Yes, and it also forks: sessions are addressed by Claude's own session id, and
the same on-disk transcript (`~/.claude/projects/<cwd>/<id>.jsonl`) is shared
with the standalone `claude` CLI, so `claude --resume <id>` reopens the exact
conversation started in Bivy. Fork/export to another node reconstructs that
transcript under a fresh id.

One caveat: resumed history is replayed by the agent on its next turn rather
than preloaded — the transcript shows immediately, but the model doesn't "see"
it again until you send a message.

## Known gaps

- The interactive TUI hand-off only appears when the standalone `claude`
  binary is separately on `PATH` — the npm SDK package alone doesn't provide
  it.
- Package installs (`capabilities.packages`) are not supported through this
  runtime.

## Run it

Pick Claude Code in the agent picker, or:

```bash
bivy run claude
```
