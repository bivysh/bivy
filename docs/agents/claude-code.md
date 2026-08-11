# Claude Code

Bivy connects to the operator-installed Claude Code agent through Anthropic's
SDK protocol bridge. The bridge is isolated under `src/agents/claude-code/` and
sets `pathToClaudeCodeExecutable` explicitly, so the SDK cannot silently use its
bundled fallback agent.

- **Runtime id:** `claude-code-sdk` (aliases `claude`, `claude-code`)
- **Tier:** Supported · **In picker:** Yes

## Install

```bash
npm install -g @anthropic-ai/claude-code
# or
bivy agents:install
```

The Bivy distribution carries the SDK as protocol glue, but availability depends
on the real `claude` command being present. Set `BIVY_CLAUDE_COMMAND` to an
explicit command/path on managed nodes.

## Authentication and configuration

**Auth owner: Claude Code.** Sign in and configure the native agent normally:

```bash
claude
/login
```

The integration deliberately does not inject Bivy's Anthropic credential over
Claude Code's own login. It reuses the CLI's existing configuration, projects,
plugins, hooks, MCP configuration, sessions, and subscription/API credentials.

## Models

Models come from the live SDK connection (`supportedModels()`) once a session is
running. Before that, the picker shows a bounded fallback list. Set an optional
session default with:

```bash
BIVY_CLAUDE_MODEL=claude-opus-4-8
```

## Resume and governance

Sessions use Claude Code's native session ids and `~/.claude/projects` store, so
`claude --resume <id>` opens the same conversation. Structured tool requests pass
through Bivy's policy/approval callback, while the selected access tier maps to
Claude Code's native permission mode. The bridge also preserves streaming,
usage, model selection, native session discovery/adoption, and attach-to-chat.

## Run it

```bash
bivy run claude
bivy shim install claude   # optional transparent terminal interception
```
